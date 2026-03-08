
// server.js - Servidor principal do WebOS
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ============================================
// CLASSE PRINCIPAL DO SERVIDOR WEBOS
// ============================================
class WebOSServer {
    constructor() {
        this.usuarios = new Map();        // Usuários conectados
        this.arquivos = new Map();         // Sistema de arquivos virtual
        this.apps = new Map();              // Aplicativos disponíveis
        this.appRepository = new Map();   // Repositório de apps para download
        this.sessoes = new Map();           // Sessões ativas
        this.processos = new Map();         // Processos rodando
        
        this.discos = {
            ssd: new DiscoVirtual('ssd', 100 * 1024 * 1024 * 1024), // 100GB
            hdd: new DiscoVirtual('hdd', 1000 * 1024 * 1024 * 1024), // 1TB
            backup: new BackupVirtual()       // Backup automático
        };
        
        this.init();
    }
    
    init() {
        // Carrega apps padrão
        this.carregarAppsPadrao();
        this.carregarRepositorioApps();
        this.carregarEstado(); // Carrega usuários e arquivos
        
        // Cria estrutura inicial de arquivos
        this.criarEstruturaInicial();
        
        console.log('🚀 Servidor WebOS iniciado!');
    }
    
    async carregarUsuarios() {
        try {
            const dados = await fs.readFile('users.json', 'utf8');
            const usuariosObj = JSON.parse(dados);
            for (const [nome, usuario] of Object.entries(usuariosObj)) {
                usuario.criado = new Date(usuario.criado);
                usuario.ultimo_acesso = new Date(usuario.ultimo_acesso);
                this.usuarios.set(nome, usuario);
            }
            console.log(`👥 ${this.usuarios.size} usuários carregados.`);
        } catch (erro) {
            console.log('ℹ️ Iniciando nova base de usuários.');
        }
    }

    async salvarEstado() {
        // Salva Usuários
        const usuariosObj = Object.fromEntries(this.usuarios);
        await fs.writeFile('users.json', JSON.stringify(usuariosObj, null, 2));
        
        // Salva Metadata dos Arquivos
        const arquivosObj = Array.from(this.arquivos.entries());
        await fs.writeFile('filesystem.json', JSON.stringify(arquivosObj, null, 2));
        
        // Salva Conteúdo do Disco SSD (Persistência Simples)
        const ssdDados = Array.from(this.discos.ssd.dados.entries());
        await fs.writeFile('disk_ssd.json', JSON.stringify(ssdDados));
    }

    async carregarEstado() {
        await this.carregarUsuarios();
        
        // Carrega Metadata
        try {
            const fsData = await fs.readFile('filesystem.json', 'utf8');
            this.arquivos = new Map(JSON.parse(fsData));
            // Restaura datas
            for (let [k, v] of this.arquivos) {
                v.criado = new Date(v.criado);
                v.modificado = new Date(v.modificado);
            }
            console.log(`📂 ${this.arquivos.size} arquivos indexados.`);
        } catch (e) { console.log('ℹ️ Novo sistema de arquivos.'); }
        
        // Carrega Conteúdo SSD
        try {
            const diskData = await fs.readFile('disk_ssd.json', 'utf8');
            const entries = JSON.parse(diskData);
            this.discos.ssd.dados = new Map(entries);
            // Restaura Buffers e Espaço Usado
            this.discos.ssd.espacoUsado = 0;
            for (let [k, v] of this.discos.ssd.dados) {
                v.salvo = new Date(v.salvo);
                if (v.conteudo && v.conteudo.type === 'Buffer') {
                    v.conteudo = Buffer.from(v.conteudo.data);
                }
                this.discos.ssd.espacoUsado += v.tamanho;
            }
            console.log(`💾 Disco SSD carregado: ${(this.discos.ssd.espacoUsado / 1024 / 1024).toFixed(2)} MB usados.`);
        } catch (e) { console.log('ℹ️ Disco SSD inicializado vazio.'); }
    }

    // ========================================
    // GERENCIAMENTO DE USUÁRIOS
    // ========================================
    async conectarUsuario(ws, dados) {
        const { usuario, senha } = dados;
        
        // Valida usuário (simplificado)
        if (!this.usuarios.has(usuario)) {
            // Cria usuário novo
            this.usuarios.set(usuario, {
                nome: usuario,
                senha: senha,
                pasta: `/usuarios/${usuario}`,
                criado: new Date(),
                ultimo_acesso: new Date(),
                configuracoes: {
                    tema: 'escuro',
                    resolucao: '1920x1080'
                }
            });
            
            // Cria pasta do usuário
            this.criarPastaUsuario(usuario);
            this.salvarEstado();
        } else {
            const usuarioExistente = this.usuarios.get(usuario);
            if (usuarioExistente.senha && usuarioExistente.senha !== senha) {
                throw new Error('Senha incorreta!');
            }
            usuarioExistente.ultimo_acesso = new Date();
            this.usuarios.set(usuario, usuarioExistente);
            this.salvarEstado();
        }
        
        // Cria sessão
        const token = crypto.randomBytes(16).toString('hex');
        this.sessoes.set(token, {
            usuario,
            ws,
            conectado: new Date(),
            processos: [],
            clipboard: '' // Área de transferência da sessão
        });
        
        // Envia resposta
        ws.send(JSON.stringify({
            tipo: 'login_sucesso',
            token,
            usuario: this.usuarios.get(usuario),
            area_trabalho: await this.getAreaTrabalho(usuario)
        }));
        
        return token;
    }
    
    // Envia notificação para o usuário
    enviarNotificacao(usuario, mensagem, tipo = 'info') {
        for (let [token, sessao] of this.sessoes) {
            if (sessao.usuario === usuario && sessao.ws.readyState === WebSocket.OPEN) {
                sessao.ws.send(JSON.stringify({
                    tipo: 'notificacao',
                    mensagem,
                    nivel: tipo
                }));
            }
        }
    }

    // ========================================
    // SISTEMA DE ARQUIVOS
    // ========================================
    async salvarArquivo(usuario, caminho, conteudo, tipo) {
        const caminhoCompleto = `/usuarios/${usuario}/${caminho}`;
        
        // Decide onde armazenar baseado no tamanho/tipo
        const tamanho = conteudo.length;
        let destino = 'ssd'; // Padrão para arquivos pequenos
        
        if (tamanho > 100 * 1024 * 1024) { // > 100MB
            destino = 'hdd';
        }
        
        if (tipo && tipo.includes('video/') && tamanho > 500 * 1024 * 1024) { // > 500MB
            destino = 'hdd';
        }
        
        // Salva no disco virtual
        const hash = await this.discos[destino].salvar(caminhoCompleto, conteudo);
        
        // Registra metadata
        this.arquivos.set(caminhoCompleto, {
            nome: path.basename(caminho),
            caminho: caminhoCompleto,
            tamanho,
            tipo: tipo || 'application/octet-stream',
            destino,
            hash,
            criado: new Date(),
            modificado: new Date(),
            dono: usuario,
            backup: true
        });
        
        // Backup automático para arquivos importantes
        if (tipo && (tipo.includes('document') || tipo.includes('text'))) {
            this.discos.backup.fazerBackup(caminhoCompleto, conteudo);
        }
        
        // Persiste o estado no disco do servidor
        this.salvarEstado();
        
        return {
            sucesso: true,
            caminho: caminhoCompleto,
            tamanho,
            destino
        };
    }
    
    async lerArquivo(usuario, caminho) {
        const caminhoCompleto = `/usuarios/${usuario}/${caminho}`;
        const metadata = this.arquivos.get(caminhoCompleto);
        
        if (!metadata) {
            throw new Error('Arquivo não encontrado');
        }
        
        // Lê do disco apropriado
        const conteudo = await this.discos[metadata.destino].ler(metadata.caminho, metadata.hash);
        
        // Cache em memória para acesso rápido
        this.cacheArquivo(caminhoCompleto, conteudo);
        
        return {
            conteudo,
            metadata
        };
    }
    
    async listarArquivos(usuario, pasta = '') {
        const prefixo = `/usuarios/${usuario}/${pasta}`;
        const arquivos = [];
        
        for (let [caminho, meta] of this.arquivos) {
            if (caminho.startsWith(prefixo) && caminho !== prefixo) {
                const relativo = caminho.replace(`/usuarios/${usuario}/`, '');
                arquivos.push({
                    ...meta,
                    caminho_relativo: relativo
                });
            }
        }
        
        return arquivos;
    }
    
    cacheArquivo(caminho, conteudo) {
        // Mantém últimos 100 arquivos em memória
        if (!this.cache) this.cache = new Map();
        
        if (this.cache.size > 100) {
            const primeiro = this.cache.keys().next().value;
            this.cache.delete(primeiro);
        }
        
        this.cache.set(caminho, {
            conteudo,
            timestamp: Date.now()
        });
    }
    
    // ========================================
    // APLICATIVOS
    // ========================================
    carregarAppsPadrao() {
        // App Gerenciador de Arquivos
        this.apps.set('file_manager', {
            nome: 'Gerenciador de Arquivos',
            versao: '1.0',
            tipo: 'sistema',
            icone: '📁',
            descricao: 'Navegue pelos seus arquivos e pastas.',
            ui:
                '<div class="app-file-manager" style="display:flex; flex-direction:column; height:100%; background:var(--bg-primary); color:var(--text-primary);">' +
                    '<div style="padding:10px; background:var(--bg-tertiary); border-bottom:1px solid var(--border-light); display:flex; flex-wrap:wrap; gap:10px; align-items:center;">' +
                       '<button onclick="fmNavegar(\'' + '{id}' + '\', \'..\')" style="cursor:pointer; padding:5px 10px; border-radius:4px; border:1px solid var(--border-light);">⬆️ Voltar</button>' +
                        '<button onclick="fmAtualizar(\'' + '{id}' + '\')" style="cursor:pointer; padding:5px 10px; border-radius:4px; border:1px solid var(--border-light);">🔄</button>' +
                        '<input type="text" id="fm-path-{id}" value="/" readonly style="flex:1; min-width:150px; padding:5px; border-radius:4px; border:1px solid var(--border-light); background:var(--bg-secondary); color:var(--text-primary);">' +
                        '<input type="text" id="fm-search-{id}" placeholder="🔎 Pesquisar arquivos..." onkeydown="if(event.key===\'Enter\') fmPesquisar(\'{id}\')" style="width:200px; padding:5px; border-radius:4px; border:1px solid var(--border-light);">' +
                    '</div>' +
                    '<div id="fm-lista-{id}" style="flex:1; overflow-y:auto; padding:10px; display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:10px; align-content:start;">' +
                        'Carregando...' +
                    '</div>' +
                '</div>',
            logica: (comando, args, usuario) => this.fileManagerLogic(comando, args, usuario)
        });

        // App Calculadora
        this.apps.set('calculadora', {
            nome: 'Calculadora',
            versao: '1.0',
            tipo: 'leve',
            ui: `
                <div class="app-calculadora">
                    <div class="calc-display" id="display-{id}">0</div>
                    <div class="calc-buttons">
                        <button class="calc-button operator" onclick="calc('{id}', 'C')">C</button>
                        <button class="calc-button" onclick="calc('{id}', '±')">±</button>
                        <button class="calc-button" onclick="calc('{id}', '%')">%</button>
                        <button class="calc-button operator" onclick="calc('{id}', '/')">÷</button>
                        
                        <button class="calc-button number" onclick="calc('{id}', '7')">7</button>
                        <button class="calc-button number" onclick="calc('{id}', '8')">8</button>
                        <button class="calc-button number" onclick="calc('{id}', '9')">9</button>
                        <button class="calc-button operator" onclick="calc('{id}', '*')">×</button>
                        
                        <button class="calc-button number" onclick="calc('{id}', '4')">4</button>
                        <button class="calc-button number" onclick="calc('{id}', '5')">5</button>
                        <button class="calc-button number" onclick="calc('{id}', '6')">6</button>
                        <button class="calc-button operator" onclick="calc('{id}', '-')">-</button>
                        
                        <button class="calc-button number" onclick="calc('{id}', '1')">1</button>
                        <button class="calc-button number" onclick="calc('{id}', '2')">2</button>
                        <button class="calc-button number" onclick="calc('{id}', '3')">3</button>
                        <button class="calc-button operator" onclick="calc('{id}', '+')">+</button>
                        
                        <button class="calc-button number" style="grid-column: span 2;" onclick="calc('{id}', '0')">0</button>
                        <button class="calc-button number" onclick="calc('{id}', '.')">.</button>
                        <button class="calc-button equals" onclick="calc('{id}', '=')">=</button>
                    </div>
                </div>
            `,
            logica: (comando, args) => {
                return this.calculadoraLogic(comando, args);
            }
        });
        
        // App Bloco de Notas
        this.apps.set('bloco_notas', {
            nome: 'Bloco de Notas',
            versao: '1.0',
            tipo: 'leve',
            ui: `
                <div class="app-bloco-notas" style="
                    background: white;
                    border-radius: 5px;
                    overflow: hidden;
                    width: 500px;
                    height: 400px;
                ">
                    <style>
                        .menu {
                            background: #f0f0f0;
                            padding: 5px;
                            border-bottom: 1px solid #ccc;
                        }
                        .menu-item {
                            display: inline-block;
                            padding: 5px 10px;
                            cursor: pointer;
                        }
                        .menu-item:hover { background: #ddd; }
                        textarea {
                            width: 100%;
                            height: calc(100% - 70px);
                            border: none;
                            outline: none;
                            padding: 10px;
                            font-family: monospace;
                            resize: none;
                        }
                        .status-bar {
                            background: #f0f0f0;
                            padding: 3px 10px;
                            font-size: 12px;
                            border-top: 1px solid #ccc;
                        }
                    </style>
                    
                    <div class="menu">
                        <span class="menu-item" onclick="notas('{id}', 'novo')">Novo</span>
                        <span class="menu-item" onclick="notas('{id}', 'abrir')">Abrir</span>
                        <span class="menu-item" onclick="notas('{id}', 'salvar')">Salvar</span>
                        <span class="menu-item" onclick="notas('{id}', 'salvar_como')">Salvar Como</span>
                        <span class="menu-item" onclick="notas('{id}', 'copiar')">Copiar Tudo</span>
                        <span class="menu-item" onclick="notas('{id}', 'colar')">Colar</span>
                    </div>
                    
                    <textarea id="texto-{id}" placeholder="Digite seu texto aqui..."></textarea>
                    
                    <div class="status-bar" id="status-{id}">
                        Linhas: 0 | Palavras: 0
                    </div>
                </div>
            `,
            logica: (comando, args, usuario) => {
                return this.blocoNotasLogic(comando, args, usuario);
            }
        });
        
        // App Visualizador de Fotos
        this.apps.set('fotos', {
            nome: 'Visualizador de Fotos',
            versao: '1.0',
            tipo: 'leve',
            ui: `
                <div class="app-fotos" style="
                    background: #1a1a1a;
                    border-radius: 5px;
                    overflow: hidden;
                    width: 800px;
                    height: 600px;
                ">
                    <style>
                        .galeria {
                            display: grid;
                            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                            gap: 10px;
                            padding: 10px;
                            height: calc(100% - 40px);
                            overflow-y: auto;
                        }
                        .miniatura {
                            background: #333;
                            height: 150px;
                            border-radius: 5px;
                            cursor: pointer;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: white;
                            font-size: 12px;
                            text-align: center;
                        }
                        .miniatura:hover {
                            background: #444;
                        }
                        .barra-titulo {
                            background: #2d2d2d;
                            color: white;
                            padding: 10px;
                            border-bottom: 1px solid #444;
                        }
                    </style>
                    
                    <div class="barra-titulo">
                        📁 Minhas Fotos
                    </div>
                    
                    <div class="galeria" id="galeria-{id}">
                        Carregando fotos...
                    </div>
                </div>
            `,
            logica: (comando, args, usuario) => {
                return this.fotosLogic(comando, args, usuario);
            }
        });
        
        // App Navegador Google
        this.apps.set('navegador', {
            nome: 'Navegador Google',
            versao: '1.0',
            tipo: 'rede',
            ui: `
                <div class="app-navegador" style="
                    background: #f0f0f0;
                    border-radius: 5px;
                    overflow: hidden;
                    width: 800px;
                    height: 600px;
                    display: flex;
                    flex-direction: column;
                ">
                    <style>
                        .barra-endereco {
                            padding: 10px;
                            background: #ddd;
                            display: flex;
                            gap: 10px;
                            border-bottom: 1px solid #ccc;
                        }
                        .barra-endereco input {
                            flex: 1;
                            padding: 5px;
                            border: 1px solid #999;
                            border-radius: 3px;
                        }
                        .barra-endereco button {
                            padding: 5px 15px;
                            cursor: pointer;
                            background: #4285f4;
                            color: white;
                            border: none;
                            border-radius: 3px;
                        }
                        iframe {
                            flex: 1;
                            border: none;
                            background: white;
                        }
                    </style>
                    
                    <div class="barra-endereco">
                        <input type="text" id="url-{id}" value="https://www.google.com/webhp?igu=1" placeholder="Digite a URL...">
                        <button onclick="navegar('{id}')">Ir</button>
                    </div>
                    
                    <iframe id="frame-{id}" src="https://www.google.com/webhp?igu=1"></iframe>
                </div>
            `,
            logica: (comando, args) => {
                return this.navegadorLogic(comando, args);
            }
        });
        
        // App Store
        this.apps.set('app_store', {
            nome: 'App Store',
            versao: '1.0',
            tipo: 'sistema',
            ui: `
                <div class="app-store" style="width:700px; height:500px; display:flex; flex-direction:column; background:#1a1f2a;">
                    <style>
                        .app-store h2 { color: #64b5f6; padding: 20px; border-bottom: 1px solid #3a3f4a;}
                        .app-item { display:flex; justify-content:space-between; align-items:center; padding:15px 20px; border-bottom:1px solid #3a3f4a;}
                        .app-item-info { display:flex; flex-direction:column; }
                        .app-item-info strong { font-size: 16px; color: white; }
                        .app-item-info span { font-size: 12px; color: #aaa; margin-top: 4px; }
                        .app-item button { padding:8px 15px; cursor:pointer; background: #64b5f6; color: white; border: none; border-radius: 3px; }
                        .app-item button:hover { background: #42a5f5; }
                        .app-item button:disabled { background: #555; cursor: not-allowed; }
                        .store-search { padding: 15px 20px; display: flex; gap: 10px; background: #2a2f3a; }
                        .store-search input { flex: 1; padding: 8px; border-radius: 4px; border: 1px solid #444; background: #1a1f2a; color: white; }
                    </style>
                    <h2>🛒 Loja de Aplicativos</h2>
                    <div class="store-search">
                        <input type="text" id="app-busca-{id}" placeholder="Buscar por Photopea, Spotify, VS Code...">
                        <button onclick="buscarApps('{id}')">🔍 Buscar</button>
                    </div>
                    <div id="lista-apps-store-{id}" style="flex:1; overflow-y:auto;">Carregando destaques...</div>
                </div>
            `,
            logica: (comando, args, usuario) => {
                if (comando === 'listar') {
                    const appsDisponiveis = [];
                    for (const [id, app] of this.appRepository) {
                        if (!this.apps.has(id)) {
                            appsDisponiveis.push({ id, nome: app.nome, versao: app.versao });
                        }
                    }
                    return { apps: appsDisponiveis };
                }
                if (comando === 'buscar_apps') {
                    const termo = args.termo.toLowerCase();
                    const appsEncontrados = [];
                    for (const [id, app] of this.appRepository) {
                        if (!this.apps.has(id)) { // Só mostra apps não instalados
                            const nome = app.nome.toLowerCase();
                            const desc = (app.descricao || '').toLowerCase();
                            if (nome.includes(termo) || desc.includes(termo)) {
                                appsEncontrados.push({ id, nome: app.nome, versao: app.versao, descricao: app.descricao });
                            }
                        }
                    }
                    return { apps_encontrados: appsEncontrados };
                }
                return {};
            }
        });

        // App Terminal
        this.apps.set('terminal', {
            nome: 'Terminal',
            versao: '1.0',
            tipo: 'sistema',
            ui: `
                <div class="app-terminal" style="background:#000; color:#0f0; height:100%; font-family:monospace; padding:10px; display:flex; flex-direction:column;">
                    <div class="terminal-output" style="flex:1; overflow-y:auto; white-space:pre-wrap;">WebOS Terminal [Versão 1.0]\n(c) 2026 WebOS Corp. Todos os direitos reservados.\n\n</div>
                    <div style="display:flex;">
                        <span style="color: #81c784;">demo@webos:~$ </span>
                        <input type="text" onkeydown="if(event.key==='Enter') term('{id}', this.value, this)" style="background:transparent; border:none; color:#0f0; flex:1; outline:none; font-family:monospace;">
                    </div>
                </div>
            `,
            logica: (comando, args, usuario) => this.terminalLogic(comando, args, usuario)
        });

        // App Gerenciador de Tarefas
        this.apps.set('task_manager', {
            nome: 'Gerenciador de Tarefas',
            versao: '1.0',
            tipo: 'sistema',
            icone: '📊',
            descricao: 'Monitore e gerencie processos do sistema.',
            ui: `
                <div class="app-task-manager" style="width:100%; height:100%; display:flex; flex-direction:column; background:#1e1e2f; color:white;">
                    <div style="padding:10px; background:#2a2a3f; display:flex; justify-content:space-between; align-items:center;">
                        <h3 style="margin:0;">Gerenciador de Tarefas</h3>
                        <button onclick="atualizarTarefas('{id}')">Atualizar</button>
                    </div>
                    <div style="flex:1; overflow-y:auto;">
                        <table style="width:100%; border-collapse:collapse;">
                            <thead>
                                <tr style="background:#2a2a3f; text-align:left;">
                                    <th style="padding:8px;">Nome do Processo</th>
                                    <th style="padding:8px;">PID</th>
                                    <th style="padding:8px;">CPU</th>
                                    <th style="padding:8px;">Memória</th>
                                    <th style="padding:8px;">Ação</th>
                                </tr>
                            </thead>
                            <tbody id="lista-tarefas-{id}">
                                <tr><td colspan="5" style="text-align:center; padding:20px;">Clique em 'Atualizar' para ver os processos.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            `,
            logica: (comando, args, usuario) => this.taskManagerLogic(comando, args, usuario)
        });

        // App Clipboard Viewer
        this.apps.set('clipboard_viewer', {
            nome: 'Área de Transferência',
            versao: '1.0',
            tipo: 'sistema',
            icone: '📋',
            descricao: 'Visualize e limpe o conteúdo da área de transferência da sessão.',
            ui: `
                <div class="app-clipboard" style="width:100%; height:100%; display:flex; flex-direction:column; background:#f0f0f0; color:black;">
                    <div style="padding:10px; background:#ddd; border-bottom:1px solid #ccc;">
                        <button onclick="atualizarClipboard('{id}')">Atualizar</button>
                        <button onclick="limparClipboard('{id}')" style="background:#e57373; color:white;">Limpar</button>
                    </div>
                    <textarea id="clipboard-content-{id}" style="flex:1; width:100%; border:none; padding:10px; resize:none;" readonly placeholder="Clique em 'Atualizar' para ver o conteúdo..."></textarea>
                </div>
            `,
            logica: () => ({ status: 'ok' }) // A lógica é toda no cliente
        });

        // App Game Center (Movido para Apps Padrão)
        this.apps.set('game_center', {
            nome: 'Game Center',
            versao: '1.0',
            tipo: 'sistema',
            icone: '🏛️',
            ui: `
                <div class="app-game-center" style="width:100%; height:100%; display:flex; flex-direction:column; background:#1a1f2a;">
                    <div style="padding:15px; background:#2a2f3a; border-bottom:1px solid #3a3f4a;">
                        <h3 style="color:#64b5f6;">🏛️ Game Center - Biblioteca de ROMs</h3>
                        <div style="display:flex; gap:10px; margin-top:10px;">
                            <input type="text" id="game-busca-{id}" placeholder="Buscar por Mario, Zelda, Metroid..." style="flex:1; padding:8px; background:#1a1f2a; border:1px solid #444; color:white; border-radius:4px;">
                            <button onclick="buscarJogos('{id}')">Buscar Online</button>
                            <button onclick="carregarJogoLocal('{id}')" title="Carregar ROM do seu PC">Carregar Local</button>
                        </div>
                    </div>
                    <div id="game-resultados-{id}" style="flex:1; overflow-y:auto; padding:10px;">
                        <p style="text-align:center; color:#888; padding:20px;">Busque por um jogo para ver a lista de ROMs disponíveis no Internet Archive.</p>
                    </div>
                </div>
            `,
            logica: (comando, args) => this.gameCenterLogic(comando, args)
        });

        // App Android Emulator (Appetize.io)
        this.apps.set('android_emulator', {
            nome: 'Android Emulator',
            versao: '1.0',
            tipo: 'emulador',
            icone: '🤖',
            descricao: 'Emulador Android via Appetize.io. Requer API Token.',
            descricao: 'Emulador Android via Appetize.io.',
            ui: `
                <div class="app-android" style="width:100%; height:100%; display:flex; flex-direction:column; background:#1e1e1e; color:white;">
                    <div style="padding:15px; background:#2d2d2d; border-bottom:1px solid #333; display:flex; flex-direction:column; gap:10px;">
                        <div style="display:flex; gap:10px;">
                            <input type="text" id="appetize-token-{id}" placeholder="Appetize.io API Token" style="flex:1; padding:8px; border-radius:4px; border:1px solid #444; background:#1e1e1e; color:white;">
                            <input type="text" id="android-busca-{id}" placeholder="Pesquisar App (ex: Calculator, Flappy Bird)..." style="flex:1; padding:8px; border-radius:4px; border:1px solid #444; background:#1e1e1e; color:white;">
                            <button onclick="buscarApkAppetize('{id}')" style="padding:8px 15px; background:#3ddc84; color:#000; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">🔍 Buscar</button>
                        </div>
                        <div style="display:flex; gap:10px;">
                            <input type="text" id="apk-url-{id}" placeholder="URL do APK (ex: https://example.com/app.apk)" style="flex:1; padding:8px; border-radius:4px; border:1px solid #444; background:#1e1e1e; color:white;">
                            <button onclick="instalarApkAppetize('{id}')" style="padding:8px 15px; background:#3ddc84; color:#000; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">▶️ Rodar</button>
                        </div>
                    </div>
                    <div id="android-lista-{id}" style="background:#252526; max-height:150px; overflow-y:auto; display:none; border-bottom:1px solid #333;"></div>
                    <div id="android-container-{id}" style="flex:1; display:flex; justify-content:center; align-items:center; background:#000; overflow:hidden;">
                        <div style="text-align:center; color:#666;">
                            <div style="font-size:3rem; margin-bottom:10px;">🤖</div>
                            <p>Insira o Token e a URL do APK para iniciar.</p>
                            <p>Pesquise um app para iniciar.</p>
                        </div>
                    </div>
                </div>
            `,
            logica: (comando, args) => this.androidEmulatorLogic(comando, args)
        });
    }
    
    carregarRepositorioApps() {
        // App Paint (para download)
        this.appRepository.set('paint', {
            nome: 'Paint',
            versao: '1.0',
            tipo: 'grafico',
            ui: `
                <div class="app-paint" style="width:600px; height:400px; background: #ccc; display:flex; flex-direction:column;">
                    <style>
                        .paint-toolbar { padding:5px; background:#eee; border-bottom:1px solid #999; color: #000; }
                        #canvas-{id} { background:white; cursor:crosshair; flex:1; }
                    </style>
                    <div class="paint-toolbar">
                        Cor: <input type="color" id="paint-color-{id}" value="#ff0000">
                        Tamanho: <input type="range" id="paint-size-{id}" min="1" max="50" value="5">
                        <button onclick="initPaint('{id}', this)">Iniciar Desenho</button>
                    </div>
                    <canvas id="canvas-{id}"></canvas>
                </div>
            `,
            logica: (comando, args) => {
                // A lógica principal do Paint é no cliente
                return { status: 'ok' };
            }
        });
        
        // App Crypto Tracker (Usa API Real)
        this.appRepository.set('crypto', {
            nome: 'Crypto Tracker',
            versao: '2.0',
            tipo: 'rede',
            ui: `
                <div class="app-crypto" style="width:400px; height:500px; background: #1a1a2e; color: white; padding: 20px;">
                    <h3 style="border-bottom: 1px solid #444; padding-bottom: 10px;">🪙 Cotações (CoinGecko)</h3>
                    <div id="crypto-list-{id}" style="margin-top: 20px;">
                        <p>Carregando dados reais...</p>
                    </div>
                    <button onclick="atualizarCrypto('{id}')" style="margin-top: 20px; width: 100%; padding: 10px; background: #e94560; border: none; color: white; cursor: pointer;">🔄 Atualizar</button>
                </div>
            `,
            logica: async (comando, args) => {
                if (comando === 'atualizar') {
                    return new Promise((resolve) => {
                        https.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,dogecoin&vs_currencies=usd,brl', {
                            headers: { 'User-Agent': 'WebOS/1.0' }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try {
                                    resolve({ precos: JSON.parse(data) });
                                } catch(e) { resolve({ erro: 'Falha ao parsear JSON' }); }
                            });
                        }).on('error', () => resolve({ erro: 'Erro de conexão' }));
                    });
                }
                return {};
            }
        });
        
        // App Clima (API Open-Meteo)
        this.appRepository.set('clima', {
            nome: 'Clima Global',
            versao: '1.5',
            tipo: 'utilitario',
            ui: `
                <div class="app-clima" style="background: linear-gradient(to bottom, #4facfe 0%, #00f2fe 100%); color: white; height: 100%; padding: 20px; display: flex; flex-direction: column; align-items: center;">
                    <h3>🌤️ Previsão do Tempo</h3>
                    <div style="display: flex; gap: 10px; margin: 20px 0; width: 100%;">
                        <input type="text" id="cidade-{id}" placeholder="Digite a cidade (ex: São Paulo)" style="flex: 1; padding: 10px; border-radius: 20px; border: none; text-align: center;">
                        <button onclick="buscarClima('{id}')" style="padding: 10px 20px; border-radius: 20px; border: none; background: white; color: #4facfe; cursor: pointer; font-weight: bold;">Buscar</button>
                    </div>
                    <div id="resultado-clima-{id}" style="text-align: center; margin-top: 20px;">
                        <p>Digite uma cidade para ver o tempo real.</p>
                    </div>
                </div>
            `,
            logica: (comando, args) => this.climaLogic(comando, args)
        });

        // App Wikipedia (API Wikipedia)
        this.appRepository.set('wikipedia', {
            nome: 'Wikipedia',
            versao: '2.0',
            tipo: 'educacao',
            ui: `
                <div class="app-wiki" style="background: #ffffff; color: #333; height: 100%; display: flex; flex-direction: column;">
                    <div style="padding: 15px; background: #f6f6f6; border-bottom: 1px solid #ccc; display: flex; gap: 10px;">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/6/63/Wikipedia-logo.png" height="30">
                        <input type="text" id="wiki-busca-{id}" placeholder="Pesquisar na Wikipedia..." style="flex: 1; padding: 5px;">
                        <button onclick="buscarWiki('{id}')">Pesquisar</button>
                    </div>
                    <div id="wiki-conteudo-{id}" style="flex: 1; padding: 20px; overflow-y: auto; font-family: serif; line-height: 1.6;">
                        <h1 style="color: #444;">Bem-vindo à Wikipedia</h1>
                        <p>O WebOS agora tem acesso à maior enciclopédia livre do mundo.</p>
                    </div>
                </div>
            `,
            logica: (comando, args) => this.wikiLogic(comando, args)
        });

        // App Tech News (API Hacker News)
        this.appRepository.set('news', {
            nome: 'Tech News',
            versao: '1.0',
            tipo: 'noticias',
            ui: `
                <div class="app-news" style="background: #f6f6ef; color: #000; height: 100%; display: flex; flex-direction: column;">
                    <div style="padding: 10px; background: #ff6600; color: white; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
                        <span>Y Hacker News</span>
                        <button onclick="atualizarNews('{id}')" style="background: white; border: none; padding: 5px 10px; cursor: pointer;">🔄</button>
                    </div>
                    <div id="news-lista-{id}" style="flex: 1; overflow-y: auto; padding: 10px;">
                        Carregando...
                    </div>
                </div>
            `,
            logica: (comando, args) => this.newsLogic(comando, args)
        });

        // App Emulador SNES (WebAssembly)
        this.appRepository.set('snes_emulator', {
  