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
            nome: 'Emulador SNES (Wasm)',
            versao: '3.0',
            tipo: 'emulador',
            icone: '🕹️',
            ui: `
                <div style="width:100%; height:100%; display:flex; flex-direction:column; background:#1c1c1c; color:white;">
                    <iframe src="https://snes.party/?rom={romUrl}" style="flex:1; border:none;" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
                </div>
            `,
            logica: () => ({ status: 'ok' })
        });

        // App Emulador NES
        this.appRepository.set('nes_emulator', {
            nome: 'Emulador NES (Wasm)',
            versao: '1.0',
            tipo: 'emulador',
            icone: '🕹️',
            ui: `<div style="width:100%; height:100%;"><iframe src="https://nes.party/?rom={romUrl}" style="width:100%; height:100%; border:none;" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>`,
            logica: () => ({ status: 'ok' })
        });

        // App Emulador GBA
        this.appRepository.set('gba_emulator', {
            nome: 'Emulador GBA (Wasm)',
            versao: '1.0',
            tipo: 'emulador',
            icone: '👾',
            ui: `<div style="width:100%; height:100%;"><iframe src="https://gba.party/?rom={romUrl}" style="width:100%; height:100%; border:none;" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>`,
            logica: () => ({ status: 'ok' })
        });

        // App Photopea
        this.appRepository.set('photopea', {
            nome: 'Photopea',
            versao: 'Web',
            tipo: 'grafico',
            icone: '🎨',
            descricao: 'Editor de imagens avançado, similar ao Photoshop, rodando no navegador.',
            ui: `
                <div style="display:flex; flex-direction:column; width:100%; height:100%;">
                    <div style="background:#333; padding:5px; display:flex; gap:10px; border-bottom:1px solid #555;">
                        <button onclick="carregarArquivoPhotopea('{id}')" style="cursor:pointer; padding:5px 10px; background:#555; color:white; border:none; border-radius:3px;">📂 Abrir Arquivo Local (.psd, .png, .jpg)</button>
                    </div>
                    <iframe id="frame-photopea-{id}" src="https://www.photopea.com" style="flex:1; border:none;"></iframe>
                </div>
            `,
            logica: () => ({ status: 'ok' })
        });

        // App VS Code Web
        this.appRepository.set('vscode_web', {
            nome: 'VS Code Web',
            versao: 'Web',
            tipo: 'desenvolvimento',
            icone: '💻',
            descricao: 'Editor de código oficial da Microsoft para a web. Acesse repositórios ou arquivos locais.',
            ui: `
                <div style="display:flex; flex-direction:column; width:100%; height:100%;">
                    <div style="background:#1e1e1e; padding:10px; border-bottom:1px solid #333; display:flex; gap:10px;">
                        <input type="text" id="repo-busca-{id}" placeholder="Buscar repositório GitHub (ex: facebook/react)..." style="flex:1; padding:5px; background:#252526; color:#ccc; border:1px solid #333;">
                        <button onclick="buscarRepos('{id}')" style="cursor:pointer; background:#007acc; color:white; border:none; padding:5px 10px;">Buscar GitHub</button>
                    </div>
                    <div id="repo-lista-{id}" style="background:#252526; max-height:200px; overflow-y:auto; display:none; border-bottom:1px solid #333;"></div>
                    <iframe id="frame-vscode-{id}" src="https://www.onlinegdb.com/online_c_compiler" style="flex:1; border:none;"></iframe>
                </div>
            `,
            logica: (comando, args) => {
                if (comando === 'buscar_repos') return this.buscarReposGithub(args.termo);
                return { status: 'ok' };
            }
        });

        // App Windows 98 Emulator
        this.appRepository.set('win98', {
            nome: 'Windows 98 Emulator',
            versao: 'v86',
            tipo: 'emulador',
            icone: '🪟',
            descricao: 'Um sistema operacional completo rodando em seu navegador via WebAssembly.',
            ui: `
                <div style="display:flex; flex-direction:column; width:100%; height:100%;">
                    <div style="background:#008080; padding:5px; display:flex; gap:10px; border-bottom:1px solid #fff; align-items:center;">
                        <button onclick="carregarDiscoWin98('{id}')" style="cursor:pointer; padding:5px 10px; background:#c0c0c0; border:2px outset #fff; font-weight:bold;">💾 Inserir Disquete/ISO</button>
                        <div style="width:1px; height:20px; background:white; margin:0 5px;"></div>
                        <input type="text" id="soft-busca-{id}" placeholder="Buscar Software Antigo (Archive.org)..." style="flex:1; padding:3px;">
                        <button onclick="buscarSoftware('{id}')" style="cursor:pointer; padding:3px 10px; background:#c0c0c0; border:2px outset #fff;">🔍</button>
                    </div>
                    <div id="soft-lista-{id}" style="background:#c0c0c0; max-height:150px; overflow-y:auto; display:none; border-bottom:2px inset #fff;"></div>
                    <iframe id="frame-win98-{id}" src="https://copy.sh/v86/?profile=windows98" style="flex:1; border:none;"></iframe>
                </div>
            `,
            logica: (comando, args) => {
                if (comando === 'buscar_software') return this.buscarSoftwareArchive(args.termo);
                return { status: 'ok' };
            }
        });

        // App Linux (Demonstração de outro OS via WebAssembly)
        this.appRepository.set('linux', {
            nome: 'Linux Terminal',
            versao: 'Kernel 2.6',
            tipo: 'emulador',
            icone: '🐧',
            descricao: 'Ambiente Linux completo rodando via WebAssembly (v86).',
            ui: `<iframe src="https://copy.sh/v86/?profile=linux26" style="width:100%; height:100%; border:none;"></iframe>`,
            logica: () => ({ status: 'ok' })
        });

        // App DOOM
        this.appRepository.set('doom', {
            nome: 'DOOM (MS-DOS)',
            versao: 'Shareware',
            tipo: 'jogo',
            icone: '👹',
            descricao: 'O clássico jogo de tiro em primeira pessoa, rodando via emulador DOSBox.',
            ui: `<iframe src="https://archive.org/embed/doom-1993-id-software" style="width:100%; height:100%; border:none;"></iframe>`,
            logica: () => ({ status: 'ok' })
        });
    }
    
    async fileManagerLogic(comando, args, usuario) {
        if (comando === 'listar') {
            let caminho = args.caminho !== undefined ? args.caminho : '';
            // Normaliza caminho (remove barra final se houver)
            if (caminho.endsWith('/')) caminho = caminho.slice(0, -1);
            
            const todosArquivos = await this.listarArquivos(usuario, caminho);
            const itens = [];
            
            // Filtra apenas filhos diretos
            for (const arq of todosArquivos) {
                let rel = arq.caminho_relativo;
                
                // Se estamos em uma subpasta, remove o prefixo da pasta atual
                if (caminho) {
                    if (!rel.startsWith(caminho + '/')) continue;
                    rel = rel.substring(caminho.length + 1);
                }
                
                const partes = rel.split('/');
                
                // Se só tem uma parte, é um filho direto
                if (partes.length === 1) {
                    itens.push({
                        nome: arq.nome,
                        tipo: arq.tipo,
                        caminho: arq.caminho_relativo,
                        icone: arq.tipo === 'directory' ? '📁' : (arq.tipo.startsWith('image') ? '🖼️' : '📄')
                    });
                }
            }
            
            return { caminhoAtual: caminho, arquivos: itens };
        }
        if (comando === 'pesquisar') {
            const termo = (args.termo || '').toLowerCase();
            if (!termo) {
                // Se a pesquisa for vazia, apenas liste o diretório atual
                return this.fileManagerLogic('listar', { caminho: args.caminho }, usuario);
            }
            
            // Pesquisa em todos os arquivos do usuário
            const todosArquivos = await this.listarArquivos(usuario, ''); 
            const itens = todosArquivos
                .filter(arq => arq.nome.toLowerCase().includes(termo))
                .map(arq => ({
                    nome: arq.nome,
                    tipo: arq.tipo,
                    caminho: arq.caminho_relativo,
                    // Adiciona o caminho do pai para contexto
                    contexto: path.dirname(arq.caminho_relativo), 
                    icone: arq.tipo === 'directory' ? '📁' : (arq.tipo.startsWith('image') ? '🖼️' : '📄')
                }));
            
            return { caminhoAtual: `Pesquisa por: "${args.termo}"`, arquivos: itens, isPesquisa: true };
        }
        return {};
    }

    async gameCenterLogic(comando, args) {
        if (comando === 'buscar_jogos') {
            return this.buscarJogosMultiplosSistemas(args.termo);
        }
        return { status: 'ok' };
    }

    async androidEmulatorLogic(comando, args) {
        const token = 'tok_lbdrpyxhox4eivc5roarla2vqq'; // Token fixo configurado

        if (comando === 'buscar') {
            const termo = args.termo;
            return new Promise(resolve => {
                // Busca APKs no Internet Archive
                const url = `https://archive.org/advancedsearch.php?q=collection:(apkarchive) AND title:(${encodeURIComponent(termo)})&fl[]=identifier,title&rows=10&output=json`;
                https.get(url, { headers: { 'User-Agent': 'WebOS-Server/1.0' } }, res => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            const docs = (json.response.docs || []).map(doc => ({
                                title: doc.title,
                                // Tenta adivinhar a URL de download direto baseada no identificador
                                apkUrl: `https://archive.org/download/${doc.identifier}/${doc.identifier}.apk`
                            }));
                            resolve({ resultados: docs });
                        } catch (e) { resolve({ erro: 'Erro ao buscar APKs.' }); }
                    });
                }).on('error', () => resolve({ erro: 'Erro de conexão.' }));
            });
        }

        if (comando === 'instalar') {
            const { url } = args;
            if (!url) return { erro: 'URL é obrigatória.' };

            return new Promise(resolve => {
                const postData = JSON.stringify({
                    url: url,
                    platform: 'android'
                });
    
                const options = {
                    hostname: 'api.appetize.io',
                    path: '/v1/apps',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': postData.length,
                        'Authorization': 'Basic ' + Buffer.from(token + ':').toString('base64')
                    }
                };
    
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            if (res.statusCode >= 200 && res.statusCode < 300) resolve({ publicKey: json.publicKey });
                            else resolve({ erro: json.message || 'Erro na API Appetize' });
                        } catch (e) {
                            resolve({ erro: 'Erro ao processar resposta da API' });
                        }
                    });
                });
    
                req.on('error', (e) => {
                    resolve({ erro: 'Erro de conexão: ' + e.message });
                });
    
                req.write(postData);
                req.end();
            });
        }
        return {};
    }

    async buscarJogosMultiplosSistemas(termo) {
        const collections = {
            snes: 'snes_library',
            nes: 'nes_library',
            gba: 'gba_library',
            gbc: 'gameboy_color_library'
        };

        const searchPromises = Object.entries(collections).map(([system, collection]) => {
            return new Promise(resolve => {
                const url = `https://archive.org/advancedsearch.php?q=collection:(${collection}) AND title:(${encodeURIComponent(termo)})&fl[]=identifier,title&rows=15&output=json`;
                https.get(url, { headers: { 'User-Agent': 'WebOS-Server/1.0' } }, res => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            const docs = (json.response.docs || []).map(doc => {
                                const identifier = doc.identifier;
                                // Heurística para adivinhar o nome do arquivo.
                                const romFile = `${doc.title.replace(/ \([^)]*\)/g, '')}.${system === 'gba' ? 'gba' : system === 'gbc' ? 'gbc' : system === 'nes' ? 'nes' : 'sfc'}`;
                                const romUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(romFile)}`;
                                return { title: doc.title, romUrl, system };
                            });
                            resolve(docs);
                        } catch (e) {
                            resolve([]); // Retorna array vazio em caso de erro de parse
                        }
                    });
                }).on('error', () => resolve([])); // Retorna array vazio em caso de erro de conexão
            });
        });

        const results = await Promise.all(searchPromises);
        const allGames = results.flat(); // Junta os resultados de todas as coleções

        return { jogos: allGames };
    }
    
    async buscarReposGithub(termo) {
        return new Promise(resolve => {
            const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(termo)}&per_page=10`;
            https.get(url, { headers: { 'User-Agent': 'WebOS-Server' } }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve({ repos: json.items || [] });
                    } catch (e) { resolve({ erro: 'Erro na API GitHub' }); }
                });
            }).on('error', () => resolve({ erro: 'Erro de conexão' }));
        });
    }

    async buscarSoftwareArchive(termo) {
        return new Promise(resolve => {
            const url = `https://archive.org/advancedsearch.php?q=collection:(softwarelibrary_win98 OR classicpcgames) AND title:(${encodeURIComponent(termo)})&fl[]=identifier,title&rows=15&output=json`;
            https.get(url, { headers: { 'User-Agent': 'WebOS-Server' } }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const docs = (json.response.docs || []).map(doc => ({
                            title: doc.title,
                            identifier: doc.identifier,
                            isoUrl: `https://archive.org/download/${doc.identifier}/${doc.identifier}.iso` 
                        }));
                        resolve({ software: docs });
                    } catch (e) { resolve({ erro: 'Erro na API Archive' }); }
                });
            }).on('error', () => resolve({ erro: 'Erro de conexão' }));
        });
    }

    async buscarRomsNoArchive(termo) {
        return new Promise(resolve => {
            const url = `https://archive.org/advancedsearch.php?q=collection:(snes_library) AND title:(${encodeURIComponent(termo)})&fl[]=identifier,title&rows=20&output=json`;
            https.get(url, { headers: { 'User-Agent': 'WebOS-Server/1.0' } }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const docs = json.response.docs.map(doc => {
                            const identifier = doc.identifier;
                            // Heurística para adivinhar o nome do arquivo. Pode falhar.
                            const romFile = `${doc.title.split(' (')[0]}.sfc`; 
                            const romUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(romFile)}`;
                            return { title: doc.title, romUrl };
                        });
                        resolve({ roms: docs });
                    } catch (e) {
                        resolve({ erro: 'Falha ao buscar ROMs no Internet Archive.' });
                    }
                });
            }).on('error', (e) => {
                resolve({ erro: 'Não foi possível conectar ao Internet Archive.' });
            });
        });
    }

    // ========================================
    // LÓGICA DO APP TERMINAL
    // ========================================
    async terminalLogic(comando, args, usuario) {
        const [cmd, ...params] = comando.trim().split(' ');
        let estado = args.estado || { caminho_atual: '' };

        switch(cmd) {
            case 'ls': {
                const dir = params[0] || estado.caminho_atual;
                const arquivos = await this.listarArquivos(usuario, dir);
                if (arquivos.length === 0) {
                    return { ...estado, output: 'Diretório vazio.' };
                }
                const output = arquivos.map(f => {
                    if (f.tipo === 'directory') {
                        return `<span style="color: #64b5f6;">${f.nome}/</span>`;
                    }
                    return f.nome;
                }).join('&nbsp;&nbsp;&nbsp;');
                return { ...estado, output };
            }
            case 'echo': {
                const texto = params.join(' ');
                return { ...estado, output: texto };
            }
            case 'pwd': {
                 return { ...estado, output: `/usuarios/${usuario}/${estado.caminho_atual}` };
            }
            case 'clear': {
                return { ...estado, clear: true };
            }
            case 'cd': {
                const novoCaminho = params[0] || '';
                
                if (novoCaminho === '..') {
                    const parts = estado.caminho_atual.split('/').filter(p => p);
                    parts.pop();
                    estado.caminho_atual = parts.join('/');
                } else if (novoCaminho === '/') {
                    estado.caminho_atual = '';
                } else if (novoCaminho.startsWith('/')) {
                    estado.caminho_atual = novoCaminho.substring(1);
                } else {
                    estado.caminho_atual = path.join(estado.caminho_atual, novoCaminho);
                }
                return { ...estado, output: '' };
            }
            case '': return { ...estado, output: '' };
            default: return { ...estado, output: `Comando não encontrado: ${cmd}` };
        }
    }

    // Lógica do Clima (Open-Meteo)
    async climaLogic(comando, args) {
        if (comando === 'buscar') {
            const cidade = args.cidade;
            return new Promise(resolve => {
                // 1. Geocoding
                https.get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt`, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        try {
                            const geo = JSON.parse(data);
                            if (!geo.results || geo.results.length === 0) {
                                resolve({ erro: 'Cidade não encontrada' });
                                return;
                            }
                            const { latitude, longitude, name, country } = geo.results[0];
                            
                            // 2. Weather
                            https.get(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`, (res2) => {
                                let data2 = '';
                                res2.on('data', c => data2 += c);
                                res2.on('end', () => {
                                    const weather = JSON.parse(data2);
                                    resolve({ 
                                        clima: weather.current_weather,
                                        local: { name, country }
                                    });
                                });
                            });
                        } catch (e) { resolve({ erro: 'Erro na API' }); }
                    });
                }).on('error', () => resolve({ erro: 'Erro de conexão' }));
            });
        }
        return {};
    }

    // Lógica da Wikipedia
    async wikiLogic(comando, args) {
        if (comando === 'buscar') {
            return new Promise(resolve => {
                const url = `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(args.termo)}&format=json&origin=*`;
                https.get(url, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve({ busca: json.query.search });
                        } catch(e) { resolve({ erro: 'Erro ao buscar' }); }
                    });
                });
            });
        }
        if (comando === 'ler') {
            return new Promise(resolve => {
                const url = `https://pt.wikipedia.org/w/api.php?action=parse&pageid=${args.pageid}&format=json&origin=*&prop=text`;
                https.get(url, (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve({ conteudo: json.parse.text['*'], titulo: json.parse.title });
                        } catch(e) { resolve({ erro: 'Erro ao ler' }); }
                    });
                });
            });
        }
        return {};
    }

    // Lógica do Hacker News
    async newsLogic(comando, args) {
        if (comando === 'listar') {
            return new Promise(resolve => {
                https.get('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15', (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        try {
                            resolve({ noticias: JSON.parse(data).hits });
                        } catch(e) { resolve({ erro: 'Erro na API' }); }
                    });
                });
            });
        }
        return {};
    }

    // Lógica do Gerenciador de Tarefas
    taskManagerLogic(comando, args, usuario) {
        if (comando === 'listar') {
            const lista = [];
            for (const [pid, proc] of this.processos) {
                if (proc.usuario === usuario) {
                    const app = this.apps.get(proc.app);
                    lista.push({
                        pid: pid,
                        nome: app ? app.nome : proc.app,
                        cpu: Math.floor(Math.random() * 15) + '%', // Simulado
                        memoria: Math.floor(Math.random() * 200) + 50 + ' MB' // Simulado
                    });
                }
            }
            return { processos: lista };
        }
        if (comando === 'matar') {
            const pid = args.pid;
            if (this.processos.has(pid)) {
                const proc = this.processos.get(pid);
                if (proc.usuario === usuario) {
                    this.processos.delete(pid);
                    return { morto: pid };
                }
            }
            return { erro: 'Processo não encontrado' };
        }
        return {};
    }

    // ========================================
    // LÓGICA DOS APPS
    // ========================================
    calculadoraLogic(comando, args) {
        const acao = comando;
        let { estado } = args;
        
        if (!estado) {
            estado = { display: '0', operador: null, primeiro: null };
        }
        
        switch(acao) {
            case 'C':
                return { display: '0', operador: null, primeiro: null };
                
            case '±':
                return { display: (parseFloat(estado.display) * -1).toString() };
                
            case '%':
                return { display: (parseFloat(estado.display) / 100).toString() };
                
            case '+':
            case '-':
            case '*':
            case '/':
                return {
                    primeiro: estado.display,
                    operador: acao,
                    display: '0'
                };
                
            case '=':
                if (estado.primeiro && estado.operador) {
                    const a = parseFloat(estado.primeiro);
                    const b = parseFloat(estado.display);
                    let resultado;
                    
                    switch(estado.operador) {
                        case '+': resultado = a + b; break;
                        case '-': resultado = a - b; break;
                        case '*': resultado = a * b; break;
                        case '/': resultado = a / b; break;
                    }
                    
                    return {
                        display: resultado.toString(),
                        primeiro: null,
                        operador: null
                    };
                }
                return estado;
                
            default:
                // Número
                if (!isNaN(acao)) {
                    const novoDisplay = estado.display === '0' ? acao : estado.display + acao;
                    return { ...estado, display: novoDisplay };
                }
                return estado;
        }
    }
    
    blocoNotasLogic(comando, args, usuario) {
        // A lógica de arquivos foi movida para o cliente usando a File System Access API.
        // O servidor não precisa mais gerenciar o conteúdo dos arquivos de texto.
        // Esta função é mantida para que o app possa ser aberto, mas não faz mais operações de arquivo.
        return { status: 'ok' };
    }
    
    fotosLogic(comando, args, usuario) {
        const acao = comando;
        const { foto } = args;
        
        switch(acao) {
            case 'listar':
                return this.listarArquivos(usuario, 'Fotos')
                    .then(fotos => {
                        return fotos.filter(f => f.tipo.startsWith('image/'));
                    });
                
            case 'ver':
                return this.lerArquivo(usuario, `Fotos/${foto}`)
                    .then(arquivo => {
                        // Converte para base64 para exibição
                        const base64 = arquivo.conteudo.toString('base64');
                        return {
                            nome: foto,
                            tipo: arquivo.metadata.tipo,
                            dados: `data:${arquivo.metadata.tipo};base64,${base64}`
                        };
                    });
                
            default:
                return { status: 'ok' };
        }
    }
    
    navegadorLogic(comando, args) {
        const acao = comando;
        const { url } = args;
        
        switch(acao) {
            case 'navegar':
                return { url };
            default:
                return { status: 'ok' };
        }
    }
    
    // ========================================
    // EXECUÇÃO DE APPS
    // ========================================
    async abrirApp(usuario, appNome, params = {}) {
        const app = this.apps.get(appNome);
        
        if (!app) {
            throw new Error('App não encontrado');
        }
        
        // Cria processo
        const processoId = crypto.randomBytes(8).toString('hex');
        const processo = {
            id: processoId,
            app: appNome,
            usuario,
            iniciado: new Date(),
            estado: {}
        };
        
        this.processos.set(processoId, processo);
        
        // Registra na sessão
        for (let [token, sessao] of this.sessoes) {
            if (sessao.usuario === usuario) {
                sessao.processos.push(processoId);
                break;
            }
        }
        
        // Prepara UI (substitui placeholders)
        let ui = app.ui; // Envia o template cru para o cliente
        
        if (params.romUrl) {
            ui = ui.replace(/\{romUrl\}/g, encodeURIComponent(params.romUrl));
        }
        
        return {
            processoId,
            ui,
            app: {
                nome: app.nome,
                versao: app.versao,
                tipo: app.tipo,
                scripts: app.scripts || [] 
            },
            params // Passa parâmetros (como arquivo para abrir) de volta para o cliente
        };
    }
    
    async executarComandoApp(usuario, processoId, comando, args) {
        const processo = this.processos.get(processoId);
        
        if (!processo) {
            throw new Error('Processo não encontrado');
        }
        
        const app = this.apps.get(processo.app);
        
        // Executa lógica do app (pode ser async)
        let resultado = app.logica(comando, args, usuario);
        
        // Se for Promise, aguarda
        if (resultado && resultado.then) {
            resultado = await resultado;
        }
        
        // Atualiza estado do processo se necessário
        if (resultado && typeof resultado === 'object') {
            processo.estado = { ...processo.estado, ...resultado };
        }
        
        return {
            processoId,
            comando,
            resultado,
            app: processo.app
        };
    }
    
    async instalarApp(appId) {
        const appData = this.appRepository.get(appId);
        if (!appData) {
            throw new Error('App não encontrado no repositório.');
        }
        if (this.apps.has(appId)) {
            console.warn(`App ${appId} já está instalado.`);
            return {
                id: appId,
                nome: appData.nome,
                icone: appData.icone || '📦'
            };
        }

        this.apps.set(appId, appData);
        console.log(`✅ App instalado: ${appData.nome}`);

        return {
            id: appId,
            nome: appData.nome,
            icone: appData.icone || '📦'
        };
    }
    
    // ========================================
    // MÉTODOS AUXILIARES
    // ========================================
    criarPastaUsuario(usuario) {
        const pastas = ['Documentos', 'Fotos', 'Videos', 'Downloads', 'Desktop'];
        
        pastas.forEach(pasta => {
            const caminho = `/usuarios/${usuario}/${pasta}`;
            
            // Cria entrada de diretório
            this.arquivos.set(caminho, {
                nome: pasta,
                caminho,
                tipo: 'directory',
                dono: usuario,
                criado: new Date()
            });
        });
    }
    
    criarEstruturaInicial() {
        // Pasta raiz de usuários
        this.arquivos.set('/usuarios', {
            nome: 'usuarios',
            caminho: '/usuarios',
            tipo: 'directory'
        });
        
        // Arquivos de sistema
        this.arquivos.set('/sistema/config.json', {
            nome: 'config.json',
            caminho: '/sistema/config.json',
            tipo: 'application/json',
            tamanho: 1024,
            destino: 'ssd'
        });
    }
    
    async getAreaTrabalho(usuario) {
        // Lista atalhos e apps padrão
        return {
            atalhos: [
                { nome: 'Meus Documentos', icone: '📁', caminho: `/usuarios/${usuario}/Documentos` },
                { nome: 'Calculadora', icone: '🧮', app: 'calculadora' },
                { nome: 'Bloco de Notas', icone: '📝', app: 'bloco_notas' },
                { nome: 'Fotos', icone: '🖼️', app: 'fotos' },
                { nome: 'Android', icone: '🤖', app: 'android_emulator' }
            ],
            papel_de_parede: '#0a0e14',
            temas: ['escuro', 'claro', 'azul']
        };
    }
}

// ============================================
// DISCOS VIRTUAIS
// ============================================
class DiscoVirtual {
    constructor(nome, tamanhoMaximo) {
        this.nome = nome;
        this.tamanhoMaximo = tamanhoMaximo;
        this.espacoUsado = 0;
        this.dados = new Map();
    }
    
    async salvar(caminho, conteudo) {
        const hash = crypto.createHash('sha256').update(conteudo).digest('hex');
        
        this.dados.set(hash, {
            caminho,
            conteudo,
            hash,
            tamanho: conteudo.length,
            salvo: new Date()
        });
        
        this.espacoUsado += conteudo.length;
        
        return hash;
    }
    
    async ler(caminho, hash) {
        const arquivo = this.dados.get(hash);
        
        if (!arquivo) {
            throw new Error('Arquivo não encontrado no disco');
        }
        
        return arquivo.conteudo;
    }
}

class BackupVirtual {
    constructor() {
        this.backups = new Map();
    }
    
    fazerBackup(caminho, conteudo) {
        if (!this.backups.has(caminho)) {
            this.backups.set(caminho, []);
        }
        
        this.backups.get(caminho).push({
            conteudo,
            data: new Date(),
            hash: crypto.createHash('sha256').update(conteudo).digest('hex')
        });
        
        // Mantém só últimos 5 backups
        if (this.backups.get(caminho).length > 5) {
            this.backups.get(caminho).shift();
        }
        
        console.log(`💾 Backup realizado: ${caminho}`);
    }
}

// ============================================
// SERVIDOR WEBSOCKET
// ============================================
const server = http.createServer((req, res) => {
    // Ignora requisições pelo favicon para não poluir o log.
    if (req.url === '/favicon.ico') {
        res.writeHead(204, { 'Content-Type': 'image/x-icon' });
        res.end();
        return;
    }

    // Log para cada requisição HTTP, para facilitar o debug inicial.
    console.log(`\n➡️  [${new Date().toLocaleTimeString()}] Requisição HTTP: ${req.method} ${req.url} (IP: ${req.socket.remoteAddress})`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(clienteHTML);
});
const wss = new WebSocket.Server({ server });
const webos = new WebOSServer();

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`🔌 Novo cliente WebSocket conectado do IP: ${clientIp}`);
    
    let usuarioAtual = null;
    let tokenAtual = null;
    
    ws.on('message', async (mensagem) => {
        try {
            const dados = JSON.parse(mensagem);
            console.log(`[${usuarioAtual || clientIp}] 📨 Comando:`, dados.tipo);
            
            switch(dados.tipo) {
                case 'login':
                    tokenAtual = await webos.conectarUsuario(ws, dados);
                    usuarioAtual = dados.usuario;
                    break;
                    
                case 'abrir_app':
                    const app = await webos.abrirApp(usuarioAtual, dados.app, dados.params);
                    ws.send(JSON.stringify({
                        tipo: 'app_aberto',
                        ...app
                    }));
                    break;
                    
                case 'comando_app':
                    const resultado = await webos.executarComandoApp(
                        usuarioAtual,
                        dados.processoId,
                        dados.comando,
                        dados.args
                    );
                    ws.send(JSON.stringify({
                        tipo: 'resultado_comando',
                        ...resultado
                    }));
                    break;
                    
                case 'salvar_arquivo':
                    const arquivo = await webos.salvarArquivo(
                        usuarioAtual,
                        dados.caminho,
                        Buffer.from(dados.conteudo, 'base64'),
                        dados.formato
                    );
                    ws.send(JSON.stringify({
                        tipo: 'arquivo_salvo',
                        ...arquivo
                    }));
                    webos.enviarNotificacao(usuarioAtual, `Arquivo salvo: ${dados.caminho}`, 'sucesso');
                    break;
                    
                case 'ler_arquivo':
                    const dadosArquivo = await webos.lerArquivo(usuarioAtual, dados.caminho);
                    ws.send(JSON.stringify({
                        tipo: 'arquivo_lido',
                        conteudo: dadosArquivo.conteudo.toString('base64'),
                        metadata: dadosArquivo.metadata,
                        reqId: dados.reqId
                    }));
                    break;
                    
                case 'listar_arquivos':
                    const arquivos = await webos.listarArquivos(usuarioAtual, dados.pasta);
                    ws.send(JSON.stringify({
                        tipo: 'lista_arquivos',
                        arquivos,
                        reqId: dados.reqId,
                        caminho: dados.pasta
                    }));
                    break;
                    
                case 'listar_apps':
                    const apps = [];
                    for (let [nome, app] of webos.apps) {
                        apps.push({
                            nome: app.nome,
                            versao: app.versao,
                            tipo: app.tipo,
                            id: nome
                        });
                    }
                    ws.send(JSON.stringify({
                        tipo: 'lista_apps',
                        apps
                    }));
                    break;
                
                case 'instalar_app':
                    const appInfo = await webos.instalarApp(dados.appId);
                    ws.send(JSON.stringify({
                        tipo: 'app_instalado',
                        app: appInfo
                    }));
                    webos.enviarNotificacao(usuarioAtual, `App ${appInfo.nome} instalado com sucesso!`, 'sucesso');
                    break;
                
                case 'clipboard_copy':
                    if (tokenAtual && webos.sessoes.has(tokenAtual)) {
                        webos.sessoes.get(tokenAtual).clipboard = dados.conteudo;
                        webos.enviarNotificacao(usuarioAtual, 'Texto copiado para a área de transferência', 'info');
                    }
                    break;

                case 'clipboard_paste':
                    if (tokenAtual && webos.sessoes.has(tokenAtual)) {
                        const content = webos.sessoes.get(tokenAtual).clipboard;
                        ws.send(JSON.stringify({ tipo: 'clipboard_content', conteudo: content }));
                    }
                    break;

                default:
                    console.log('Comando desconhecido:', dados.tipo);
            }
        } catch (erro) {
            console.error('❌ Erro:', erro);
            ws.send(JSON.stringify({
                tipo: 'erro',
                mensagem: erro.message
            }));
        }
    });
    
    ws.on('close', () => {
        console.log(`🔌 Cliente desconectado: ${usuarioAtual || clientIp}`);
        if (tokenAtual) {
            webos.sessoes.delete(tokenAtual);
        }
    });
});

// ============================================
// INICIA SERVIDOR
// ============================================
const PORT = process.env.PORT || 8080;

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`\n❌ ERRO CRÍTICO: A porta ${PORT} já está sendo usada.`);
        console.log('👉 Isso geralmente acontece porque o servidor já está rodando em outro terminal.');
        console.log('\nCOMO RESOLVER:');
        console.log('1. Encontre o outro terminal e pressione Ctrl+C para parar o servidor.');
        console.log('2. Se não encontrar, use os seguintes comandos no seu terminal (CMD ou PowerShell):');
        console.log(`   a) Para encontrar o processo: netstat -ano | findstr :${PORT}`);
        console.log('   b) Anote o número na última coluna (é o PID).');
        console.log('   c) Para forçar o fechamento: taskkill /PID SEU_NUMERO_PID /F');
        process.exit(1);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════╗
    ║     🚀 WEBOS SERVER RODANDO          ║
    ║    📡 Acesso: http://localhost:${PORT}   ║
    ║    💾 Discos: SSD (100GB) + HDD (1TB)║
    ║    👥 Usuários: Ilimitado            ║
    ║    📱 Apps: Calculadora, Notas, Fotos║
    ╚══════════════════════════════════════╝
    `);
    console.log('📌 Abra o endereço acima no seu navegador para usar o WebOS.');
});

// ============================================
// CLIENTE DE TESTE (HTML)
// ============================================
const clienteHTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>WebOS</title>
    <style>
        /* ============================================
           DESIGN SYSTEM — INSPIRADO NO macOS
           ============================================ */
        
        /* Variáveis - Tema Claro (padrão) */
        :root {
            --bg-primary: #f5f5f7;
            --bg-secondary: #ffffff;
            --bg-tertiary: rgba(255, 255, 255, 0.8);
            --bg-elevated: rgba(255, 255, 255, 0.95);
            --bg-dock: rgba(255, 255, 255, 0.7);
            --text-primary: #1d1d1f;
            --text-secondary: #6e6e73;
            --text-tertiary: #86868b;
            --accent: #0066cc;
            --accent-hover: #0077ed;
            --accent-active: #0055b3;
            --border-light: rgba(0, 0, 0, 0.1);
            --border-medium: rgba(0, 0, 0, 0.2);
            --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.04);
            --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.08);
            --shadow-lg: 0 20px 48px rgba(0, 0, 0, 0.12);
            --shadow-xl: 0 32px 64px rgba(0, 0, 0, 0.15);
            --blur-amount: 20px;
            --transition-fast: 0.15s cubic-bezier(0.25, 0.1, 0.25, 1);
            --transition-base: 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
            --transition-slow: 0.4s cubic-bezier(0.25, 0.1, 0.25, 1);
            --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            --font-mono: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace;
            --radius-sm: 6px;
            --radius-md: 8px;
            --radius-lg: 12px;
            --radius-xl: 16px;
            --radius-full: 9999px;
        }

        /* Tema Escuro */
        [data-theme="dark"] {
            --bg-primary: #1c1c1e;
            --bg-secondary: #2c2c2e;
            --bg-tertiary: rgba(44, 44, 46, 0.8);
            --bg-elevated: rgba(44, 44, 46, 0.95);
            --bg-dock: rgba(44, 44, 46, 0.7);
            --text-primary: #ffffff;
            --text-secondary: #aeaeb2;
            --text-tertiary: #8e8e93;
            --accent: #0a84ff;
            --accent-hover: #409cff;
            --accent-active: #0063ce;
            --border-light: rgba(255, 255, 255, 0.1);
            --border-medium: rgba(255, 255, 255, 0.2);
            --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.2);
            --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.3);
            --shadow-lg: 0 20px 48px rgba(0, 0, 0, 0.4);
            --shadow-xl: 0 32px 64px rgba(0, 0, 0, 0.5);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--font-sans);
            background: var(--bg-primary);
            color: var(--text-primary);
            height: 100vh;
            overflow: hidden;
            transition: background-color var(--transition-base), color var(--transition-base);
            line-height: 1.4;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }

        /* ============================================
           TELA DE LOGIN — ELEGÂNCIA E SIMPLICIDADE
           ============================================ */
        #login {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--bg-primary);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 1000;
            backdrop-filter: blur(var(--blur-amount));
        }

        .login-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            max-width: 400px;
            width: 90%;
            animation: fadeInUp 0.5s ease-out;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .login-logo {
            font-size: 4rem;
            margin-bottom: 2rem;
            filter: drop-shadow(0 10px 20px rgba(0,0,0,0.1));
        }

        .login-box {
            background: var(--bg-tertiary);
            backdrop-filter: blur(var(--blur-amount));
            padding: 2.5rem;
            border-radius: var(--radius-xl);
            box-shadow: var(--shadow-xl);
            border: 1px solid var(--border-light);
            width: 100%;
            transition: all var(--transition-base);
        }

        .login-box h2 {
            font-size: 1.75rem;
            font-weight: 600;
            margin-bottom: 1.5rem;
            color: var(--text-primary);
            letter-spacing: -0.02em;
        }

        .login-box h2::after {
            content: '';
            display: block;
            width: 40px;
            height: 4px;
            background: var(--accent);
            border-radius: var(--radius-full);
            margin-top: 0.5rem;
        }

        .input-group {
            margin-bottom: 1.25rem;
        }

        .input-group label {
            display: block;
            font-size: 0.85rem;
            font-weight: 500;
            margin-bottom: 0.35rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .input-group input {
            width: 100%;
            padding: 0.85rem 1rem;
            background: var(--bg-elevated);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 1rem;
            transition: all var(--transition-fast);
            outline: none;
        }

        .input-group input:hover {
            border-color: var(--border-medium);
        }

        .input-group input:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.2);
        }

        .login-button {
            width: 100%;
            padding: 0.85rem 1rem;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
            transition: all var(--transition-fast);
            margin-top: 0.5rem;
            box-shadow: 0 4px 12px rgba(0, 102, 204, 0.3);
        }

        .login-button:hover {
            background: var(--accent-hover);
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(0, 102, 204, 0.4);
        }

        .login-button:active {
            background: var(--accent-active);
            transform: translateY(1px);
            box-shadow: 0 2px 8px rgba(0, 102, 204, 0.3);
        }

        .login-footer {
            margin-top: 1.5rem;
            text-align: center;
            font-size: 0.85rem;
            color: var(--text-tertiary);
        }

        /* ============================================
           ÁREA DE TRABALHO PRINCIPAL
           ============================================ */
        #area-trabalho {
            display: none;
            height: 100vh;
            position: relative;
            overflow: hidden;
            background: var(--bg-primary);
        }

        /* Menu Superior (similar ao macOS) */
        #menu-superior {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 44px;
            background: var(--bg-tertiary);
            backdrop-filter: blur(var(--blur-amount));
            display: flex;
            align-items: center;
            padding: 0 20px;
            border-bottom: 1px solid var(--border-light);
            z-index: 90;
            color: var(--text-primary);
            font-size: 0.9rem;
            font-weight: 500;
        }

        .menu-left {
            display: flex;
            align-items: center;
            gap: 24px;
        }

        .menu-logo {
            font-size: 1.2rem;
            font-weight: 600;
            background: linear-gradient(135deg, var(--accent), #9370db);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .menu-item {
            padding: 4px 8px;
            border-radius: var(--radius-sm);
            cursor: default;
            transition: background var(--transition-fast);
        }

        .menu-item.clickable {
            cursor: pointer;
        }

        .menu-item.clickable:hover {
            background: var(--border-light);
        }

        .menu-right {
            margin-left: auto;
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .theme-toggle {
            background: var(--bg-secondary);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-full);
            padding: 4px;
            display: flex;
            gap: 4px;
        }

        .theme-toggle button {
            background: transparent;
            border: none;
            padding: 4px 12px;
            border-radius: var(--radius-full);
            cursor: pointer;
            color: var(--text-secondary);
            font-size: 0.85rem;
            transition: all var(--transition-fast);
        }

        .theme-toggle button.active {
            background: var(--accent);
            color: white;
        }

        .menu-time {
            font-weight: 500;
            min-width: 80px;
            text-align: right;
        }

        /* Área de aplicativos (Desktop) */
        #area-apps {
            height: calc(100vh - 44px - 80px); /* 44px menu + 80px dock */
            margin-top: 44px;
            margin-bottom: 80px;
            overflow: hidden;
            position: relative;
            background: var(--bg-primary);
        }

        /* Wallpaper com overlay para melhor contraste */
        .desktop-wallpaper {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            opacity: 0.1;
            pointer-events: none;
            z-index: 0;
        }

        /* Ícones da Área de Trabalho */
        #desktop-icons {
            position: absolute;
            top: 20px;
            left: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 5;
        }
        .desktop-icon {
            display: flex;
            flex-direction: column;
            align-items: center;
            width: 90px;
            padding: 10px;
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: background var(--transition-fast);
        }
        .desktop-icon:hover { background: rgba(128, 128, 128, 0.2); }
        .desktop-icon .icon { font-size: 3rem; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.1)); }
        .desktop-icon .name { font-size: 0.85rem; margin-top: 8px; color: var(--text-primary); text-shadow: 0 1px 2px rgba(0,0,0,0.7); word-break: break-word; text-align: center; }

        /* ============================================
           DOCK — INSPIRADO NO macOS
           ============================================ */
        #dock {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            height: 70px;
            background: var(--bg-dock);
            backdrop-filter: blur(var(--blur-amount));
            border-radius: var(--radius-xl);
            padding: 8px 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid var(--border-light);
            box-shadow: var(--shadow-lg);
            z-index: 100;
            transition: all var(--transition-base);
        }

        .dock-icon {
            width: 56px;
            height: 56px;
            background: var(--bg-elevated);
            border-radius: var(--radius-lg);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.8rem;
            cursor: pointer;
            transition: all var(--transition-fast);
            border: 1px solid var(--border-light);
            box-shadow: var(--shadow-sm);
            position: relative;
        }

        .dock-icon:hover {
            transform: scale(1.1) translateY(-5px);
            background: var(--accent);
            color: white;
            border-color: transparent;
            box-shadow: var(--shadow-md);
        }

        .dock-icon.active {
            background: var(--accent);
            color: white;
        }

        .dock-icon.active::after {
            content: '';
            position: absolute;
            bottom: -8px;
            left: 50%;
            transform: translateX(-50%);
            width: 4px;
            height: 4px;
            background: var(--accent);
            border-radius: var(--radius-full);
        }

        .dock-icon[data-tooltip]:hover::before {
            content: attr(data-tooltip);
            position: absolute;
            top: -30px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--bg-elevated);
            color: var(--text-primary);
            padding: 4px 12px;
            border-radius: var(--radius-md);
            font-size: 0.8rem;
            white-space: nowrap;
            border: 1px solid var(--border-light);
            box-shadow: var(--shadow-sm);
            backdrop-filter: blur(5px);
            z-index: 200;
        }

        .dock-separator {
            width: 1px;
            height: 40px;
            background: var(--border-light);
            margin: 0 4px;
        }

        /* ============================================
           JANELAS — ESTILO macOS
           ============================================ */
        .janela {
            position: absolute;
            background: var(--bg-secondary);
            border-radius: var(--radius-lg);
            overflow: hidden;
            box-shadow: var(--shadow-xl);
            border: 1px solid var(--border-light);
            min-width: 400px;
            min-height: 300px;
            backdrop-filter: blur(10px);
            animation: windowOpen 0.3s cubic-bezier(0.25, 0.1, 0.25, 1);
            z-index: 10;
        }

        @keyframes windowOpen {
            from {
                opacity: 0;
                transform: scale(0.95) translateY(10px);
            }
            to {
                opacity: 1;
                transform: scale(1) translateY(0);
            }
        }

        .janela.maximized {
            top: 44px !important;
            left: 0 !important;
            width: 100% !important;
            height: calc(100vh - 44px - 80px) !important;
            border-radius: 0;
            animation: none;
        }

        .janela .barra-titulo {
            background: var(--bg-tertiary);
            backdrop-filter: blur(10px);
            padding: 12px 16px;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-light);
            user-select: none;
            -webkit-app-region: drag;
        }

        .janela .window-controls {
            display: flex;
            gap: 8px;
            -webkit-app-region: no-drag;
        }

        .window-control {
            width: 12px;
            height: 12px;
            border-radius: var(--radius-full);
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .window-control.close {
            background: #ff5f57;
            border: 1px solid #e0443e;
        }

        .window-control.minimize {
            background: #febc2e;
            border: 1px solid #e0a021;
        }

        .window-control.maximize {
            background: #28c840;
            border: 1px solid #1fa52f;
        }

        .window-control:hover {
            filter: brightness(1.1);
            transform: scale(1.1);
        }

        .janela .window-title {
            font-size: 0.9rem;
            font-weight: 500;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .janela .conteudo {
            padding: 0;
            height: calc(100% - 45px);
            overflow: auto;
            background: var(--bg-primary);
            color: var(--text-primary);
        }

        /* Estilização da barra de rolagem */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        ::-webkit-scrollbar-track {
            background: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--text-tertiary);
            border-radius: var(--radius-full);
            border: 2px solid transparent;
            background-clip: padding-box;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--text-secondary);
            background-clip: padding-box;
        }

        /* ============================================
           NOTIFICAÇÕES
           ============================================ */
        #notificacoes {
            position: fixed;
            top: 60px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 1000;
            max-width: 350px;
        }

        .notificacao {
            background: var(--bg-tertiary);
            backdrop-filter: blur(var(--blur-amount));
            color: var(--text-primary);
            padding: 16px;
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-md);
            border: 1px solid var(--border-light);
            border-left: 4px solid var(--accent);
            animation: notificationSlide 0.3s ease-out;
            font-size: 0.95rem;
        }

        .notificacao.erro {
            border-left-color: #ff5f57;
        }

        .notificacao.sucesso {
            border-left-color: #28c840;
        }

        @keyframes notificationSlide {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }

        /* ============================================
           STATUS BAR
           ============================================ */
        #status {
            position: fixed;
            top: 54px;
            right: 20px;
            background: var(--bg-tertiary);
            backdrop-filter: blur(var(--blur-amount));
            padding: 8px 16px;
            border-radius: var(--radius-full);
            font-size: 0.85rem;
            border: 1px solid var(--border-light);
            box-shadow: var(--shadow-sm);
            z-index: 95;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: var(--radius-full);
            background: #28c840;
            box-shadow: 0 0 0 2px rgba(40, 200, 64, 0.3);
        }

        .status-indicator.disconnected {
            background: #ff5f57;
            box-shadow: 0 0 0 2px rgba(255, 95, 87, 0.3);
        }

        /* ============================================
           ESTILOS ESPECÍFICOS DOS APPS
           ============================================ */
        /* Calculadora */
        .app-calculadora {
            background: var(--bg-secondary);
            border-radius: var(--radius-lg);
            padding: 20px;
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        .calc-display {
            background: var(--bg-primary);
            color: var(--text-primary);
            padding: 20px;
            font-size: 2.5rem;
            text-align: right;
            margin-bottom: 20px;
            border-radius: var(--radius-md);
            font-family: var(--font-mono);
            border: 1px solid var(--border-light);
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);
        }

        .calc-buttons {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            flex: 1;
        }

        .calc-button {
            padding: 16px;
            font-size: 1.2rem;
            border: none;
            border-radius: var(--radius-md);
            cursor: pointer;
            background: var(--bg-tertiary);
            color: var(--text-primary);
            transition: all var(--transition-fast);
            border: 1px solid var(--border-light);
            font-weight: 500;
        }

        .calc-button:hover {
            background: var(--accent);
            color: white;
            transform: scale(1.02);
            border-color: transparent;
        }

        .calc-button.number {
            background: var(--bg-elevated);
        }

        .calc-button.operator {
            background: var(--accent);
            color: white;
        }

        .calc-button.equals {
            background: var(--accent);
            color: white;
            grid-column: span 2;
        }

        /* Bloco de Notas */
        .app-bloco-notas {
            height: 100%;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
        }

        .notas-toolbar {
            padding: 12px;
            background: var(--bg-tertiary);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--border-light);
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        .notas-button {
            padding: 6px 14px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-md);
            color: var(--text-primary);
            font-size: 0.9rem;
            cursor: pointer;
            transition: all var(--transition-fast);
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .notas-button:hover {
            background: var(--accent);
            color: white;
            border-color: transparent;
        }

        .notas-textarea {
            flex: 1;
            padding: 20px;
            font-family: var(--font-mono);
            font-size: 14px;
            line-height: 1.6;
            border: none;
            outline: none;
            resize: none;
            background: var(--bg-primary);
            color: var(--text-primary);
        }

        .notas-status {
            padding: 8px 16px;
            background: var(--bg-tertiary);
            border-top: 1px solid var(--border-light);
            font-size: 0.8rem;
            color: var(--text-secondary);
        }

        /* Terminal */
        .app-terminal {
            background: #1e1e1e;
            color: #98c379;
            height: 100%;
            font-family: var(--font-mono);
            padding: 16px;
            display: flex;
            flex-direction: column;
        }

        .terminal-output {
            flex: 1;
            overflow-y: auto;
            white-space: pre-wrap;
            font-size: 14px;
            line-height: 1.6;
            margin-bottom: 16px;
        }

        .terminal-line {
            display: flex;
            margin-bottom: 4px;
        }

        .terminal-prompt {
            color: #98c379;
            margin-right: 8px;
        }

        .terminal-input-line {
            display: flex;
            align-items: center;
        }

        .terminal-input {
            background: transparent;
            border: none;
            color: #98c379;
            font-family: var(--font-mono);
            font-size: 14px;
            flex: 1;
            outline: none;
        }

        /* Navegador */
        .app-navegador {
            height: 100%;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
        }

        .browser-toolbar {
            padding: 12px;
            background: var(--bg-tertiary);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--border-light);
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .browser-input {
            flex: 1;
            padding: 8px 16px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-light);
            border-radius: var(--radius-full);
            color: var(--text-primary);
            font-size: 0.9rem;
            outline: none;
        }

        .browser-input:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.2);
        }

        .browser-button {
            padding: 8px 16px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: var(--radius-full);
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .browser-button:hover {
            background: var(--accent-hover);
            transform: scale(1.05);
        }

        .browser-frame {
            flex: 1;
            border: none;
            background: white;
        }

        /* App Store */
        .app-store {
            height: 100%;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
        }

        .store-header {
            padding: 24px;
            background: linear-gradient(135deg, var(--accent), #9370db);
            color: white;
        }

        .store-title {
            font-size: 2rem;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .store-search {
            margin-top: 16px;
            display: flex;
            gap: 8px;
        }

        .store-search-input {
            flex: 1;
            padding: 12px 20px;
            border: none;
            border-radius: var(--radius-full);
            font-size: 1rem;
            background: rgba(255,255,255,0.2);
            color: white;
            outline: none;
        }

        .store-search-input::placeholder {
            color: rgba(255,255,255,0.7);
        }

        .store-search-button {
            padding: 12px 24px;
            background: white;
            color: var(--accent);
            border: none;
            border-radius: var(--radius-full);
            font-weight: 600;
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .store-search-button:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }

        .store-grid {
            flex: 1;
            padding: 24px;
            overflow-y: auto;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 16px;
        }

        .app-card {
            background: var(--bg-secondary);
            border-radius: var(--radius-lg);
            padding: 20px;
            border: 1px solid var(--border-light);
            transition: all var(--transition-fast);
            cursor: pointer;
        }

        .app-card:hover {
            transform: translateY(-4px);
            box-shadow: var(--shadow-md);
            border-color: var(--accent);
        }

        .app-icon-large {
            font-size: 3rem;
            margin-bottom: 12px;
        }

        .app-name {
            font-size: 1.2rem;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .app-description {
            font-size: 0.9rem;
            color: var(--text-secondary);
            margin-bottom: 12px;
        }

        .app-version {
            font-size: 0.8rem;
            color: var(--text-tertiary);
        }

        .install-button {
            width: 100%;
            padding: 10px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            margin-top: 16px;
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .install-button:hover {
            background: var(--accent-hover);
        }

        .install-button.installed {
            background: var(--text-tertiary);
            cursor: default;
        }

        /* Game Center */
        .game-center {
            height: 100%;
            display: flex;
            flex-direction: column;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .game-header {
            padding: 24px;
            background: rgba(0,0,0,0.2);
        }

        .game-title {
            font-size: 2rem;
            font-weight: 600;
            margin-bottom: 16px;
        }

        .game-search {
            display: flex;
            gap: 8px;
        }

        .game-search-input {
            flex: 1;
            padding: 12px 20px;
            border: none;
            border-radius: var(--radius-full);
            font-size: 1rem;
            outline: none;
        }

        .game-results {
            flex: 1;
            padding: 24px;
            overflow-y: auto;
        }

        .game-card {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: var(--radius-lg);
            padding: 16px;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid rgba(255,255,255,0.2);
        }

        .game-info h4 {
            font-size: 1.1rem;
            margin-bottom: 4px;
        }

        .game-info span {
            font-size: 0.8rem;
            opacity: 0.7;
        }

        .play-button {
            padding: 8px 20px;
            background: white;
            color: var(--accent);
            border: none;
            border-radius: var(--radius-full);
            font-weight: 600;
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .play-button:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }

        /* Task Manager */
        .task-manager {
            height: 100%;
            background: var(--bg-primary);
            display: flex;
            flex-direction: column;
        }

        .task-header {
            padding: 16px 20px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border-light);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .task-header h3 {
            font-size: 1.2rem;
            font-weight: 600;
        }

        .refresh-button {
            padding: 6px 14px;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: all var(--transition-fast);
        }

        .task-table {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
        }

        .task-table table {
            width: 100%;
            border-collapse: collapse;
        }

        .task-table th {
            text-align: left;
            padding: 12px;
            background: var(--bg-tertiary);
            font-weight: 600;
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
        }

        .task-table td {
            padding: 12px;
            border-bottom: 1px solid var(--border-light);
        }

        .kill-button {
            padding: 4px 12px;
            background: #ff5f57;
            color: white;
            border: none;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 0.8rem;
            transition: all var(--transition-fast);
        }

        .kill-button:hover {
            background: #e0443e;
        }
    </style>
</head>
<body>
    <!-- TELA DE LOGIN -->
    <div id="login">
        <div class="login-container">
            <div class="login-logo">🖥️</div>
            <div class="login-box">
                <h2>WebOS</h2>
                <div class="input-group">
                    <label>Usuário</label>
                    <input type="text" id="usuario" value="demo" placeholder="Seu nome de usuário">
                </div>
                <div class="input-group">
                    <label>Senha</label>
                    <input type="password" id="senha" value="123456" placeholder="••••••••">
                </div>
                <button class="login-button" id="login-button" onclick="fazerLogin()">Continuar</button>
                <div class="login-footer">
                    <span>Demo: usuário "demo", senha "123456"</span>
                </div>
            </div>
        </div>
    </div>

    <!-- ÁREA DE TRABALHO PRINCIPAL -->
    <div id="area-trabalho">
        <!-- Overlay de Conexão -->
        <div id="connection-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); color: white; display: none; justify-content: center; align-items: center; z-index: 9999; font-size: 1.5rem; backdrop-filter: blur(5px); flex-direction: column; gap: 20px;">
            <div style="font-size: 3rem;">📡</div>
            <div>Conexão perdida. Reconectando...</div>
        </div>

        <!-- Menu Superior (macOS style) -->
        <div id="menu-superior">
            <div class="menu-left">
                <span class="menu-logo">WebOS</span>
                <span class="menu-item">Finder</span>
                <span class="menu-item">Arquivo</span>
                <span class="menu-item">Editar</span>
                <span class="menu-item">Visualizar</span>
                <span class="menu-item">Janela</span>
                <span class="menu-item">Ajuda</span>
            </div>
            <div class="menu-right">
                <div class="theme-toggle">
                    <button class="theme-btn active" data-theme="light">🌞</button>
                    <button class="theme-btn" data-theme="dark">🌙</button>
                </div>
                <div class="menu-item clickable" onclick="mostrarSobre()">Sobre</div>
                <div class="menu-time" id="relogio-menu">--:--</div>
            </div>
        </div>

        <!-- Status Indicator -->
        <div id="status">
            <span class="status-indicator" id="status-indicator"></span>
            <span id="status-text">Conectando...</span>
        </div>

        <!-- Área de Aplicativos (Desktop) -->
        <div id="area-apps">
            <div class="desktop-wallpaper"></div>
            <!-- As janelas serão inseridas aqui dinamicamente -->
        </div>

        <!-- Dock (macOS style) -->
        <div id="dock">
            <div class="dock-icon" data-tooltip="Calculadora" onclick="abrirApp('calculadora')">🧮</div>
            <div class="dock-icon" data-tooltip="Arquivos" onclick="abrirApp('file_manager')">📁</div>
            <div class="dock-icon" data-tooltip="Bloco de Notas" onclick="abrirApp('bloco_notas')">📝</div>
            <div class="dock-icon" data-tooltip="Fotos" onclick="abrirApp('fotos')">🖼️</div>
            <div class="dock-icon" data-tooltip="Terminal" onclick="abrirApp('terminal')">🖥️</div>
            <div class="dock-icon" data-tooltip="Navegador" onclick="abrirApp('navegador')">🌐</div>
            <div class="dock-icon" data-tooltip="App Store" onclick="abrirApp('app_store')">🛒</div>
            <div class="dock-icon" data-tooltip="Game Center" onclick="abrirApp('game_center')">🎮</div>
            <div class="dock-icon" data-tooltip="Gerenciador de Tarefas" onclick="abrirApp('task_manager')">📊</div>
            <div class="dock-icon" data-tooltip="Área de Transferência" onclick="abrirApp('clipboard_viewer')">📋</div>
            <div class="dock-separator"></div>
            <div class="dock-icon" data-tooltip="Lixeira">🗑️</div>
        </div>
    </div>

    <!-- Container de Notificações -->
    <div id="notificacoes"></div>

    <script>
    // --- DEBUG DE ERROS (SCRIPT SEPARADO) ---
    // Este bloco roda separadamente para garantir que pegue erros de sintaxe no script principal
    window.onerror = function(msg, url, lineNo, columnNo, error) {
        var message = [
            'Mensagem: ' + msg,
            'Linha: ' + lineNo,
            'Coluna: ' + columnNo,
            'Erro: ' + (error ? error.message : 'Desconhecido')
        ].join('\\n');
        
        var errorDiv = document.createElement('div');
        errorDiv.style.position = 'fixed';
        errorDiv.style.top = '0';
        errorDiv.style.left = '0';
        errorDiv.style.width = '100%';
        errorDiv.style.backgroundColor = '#ff0000';
        errorDiv.style.color = '#ffffff';
        errorDiv.style.padding = '20px';
        errorDiv.style.zIndex = '999999';
        errorDiv.style.fontSize = '16px';
        errorDiv.innerText = '⚠️ ERRO CRÍTICO DE SCRIPT:\\n' + message;
        document.body.appendChild(errorDiv);
        return false;
    };
    </script>

    <script>
   // ============================================
// CLIENTE WEBOS - JAVASCRIPT COMPLETO
// ============================================

// Debug: Confirmação de carregamento do script
console.log('🚀 Script do WebOS carregado e pronto!');

// Estado global da aplicação
let socket = null;
let token = null;
let usuarioAtual = null;
let processosAbertos = new Map(); // processoId -> { janela, app }
let proximaZIndex = 100;
let clipboard = '';
let pendingCallbacks = new Map();
let seletorCallbacks = new Map(); // reqId -> callback

// ============================================
// INICIALIZAÇÃO E CONEXÃO
// ============================================
function conectarWebSocket() {
    const protocolo = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname || 'localhost';
    const porta = window.location.port ? ':' + window.location.port : '';
    
    try {
        socket = new WebSocket(protocolo + '//' + host + porta);
    } catch (e) {
        console.error('Erro ao criar WebSocket:', e);
        mostrarNotificacao('Erro crítico na conexão WebSocket', 'erro');
        return;
    }
    
    socket.onopen = () => {
        console.log('✅ Conectado ao servidor WebOS');
        atualizarStatus(true);
        // A notificação é um pouco redundante, o botão se tornando ativo é um feedback melhor.
        const loginButton = document.getElementById('login-button');
        if (loginButton) {
            loginButton.disabled = false;
            loginButton.textContent = 'Continuar';
        }
    };
    
    socket.onmessage = (evento) => {
        const dados = JSON.parse(evento.data);
        console.log('📩 Recebido:', dados.tipo, dados);
        
        switch(dados.tipo) {
            case 'login_sucesso':
                token = dados.token;
                usuarioAtual = dados.usuario;
                document.getElementById('login').style.display = 'none';
                document.getElementById('area-trabalho').style.display = 'block';
                mostrarNotificacao(\`Bem-vindo, \${usuarioAtual.nome}!\`, 'sucesso');
                if (dados.area_trabalho && dados.area_trabalho.atalhos) {
                    renderizarIconesDesktop(dados.area_trabalho.atalhos);
                }
                break;
                
            case 'app_aberto':
                abrirJanelaApp(dados);
                break;
                
            case 'resultado_comando':
                processarResultadoComando(dados);
                break;
                
            case 'notificacao':
                mostrarNotificacao(dados.mensagem, dados.nivel);
                break;
                
            case 'lista_apps':
                atualizarListaApps(dados.apps);
                break;
                
            case 'app_instalado':
                mostrarNotificacao(\`App \${dados.app.nome} instalado!\`, 'sucesso');
                adicionarAppAoDock(dados.app);
                break;
            
            case 'lista_arquivos':
                if (dados.reqId && seletorCallbacks.has(dados.reqId)) {
                    seletorCallbacks.get(dados.reqId)(dados);
                }
                break;

            case 'arquivo_lido':
                if (dados.reqId) {
                    const textarea = document.getElementById('texto-' + dados.reqId);
                    if (textarea) {
                        // Decodifica Base64 UTF-8 corretamente
                        const texto = decodeURIComponent(escape(atob(dados.conteudo)));
                        textarea.value = texto;
                        atualizarStatusNotas(dados.reqId);
                        mostrarNotificacao('Arquivo carregado com sucesso!', 'sucesso');
                    }
                }
                break;
                
            case 'clipboard_content':
                clipboard = dados.conteudo;
                atualizarClipboardViewer();
                break;
                
            case 'erro':
                mostrarNotificacao('Erro: ' + dados.mensagem, 'erro');
                // Reabilita o botão de login se o erro ocorrer na tela de login
                const loginButton = document.getElementById('login-button');
                if (loginButton && document.getElementById('login').style.display !== 'none') {
                    loginButton.disabled = false;
                    loginButton.textContent = 'Continuar';
                }
                break;
        }
    };
    
    socket.onclose = () => {
        console.log('❌ Desconectado do servidor');
        atualizarStatus(false);
        const loginButton = document.getElementById('login-button');
        if (loginButton && document.getElementById('login').style.display !== 'none') {
            loginButton.disabled = true;
            loginButton.textContent = 'Reconectando...';
        }
        mostrarNotificacao('Conexão perdida. Tentando reconectar...', 'erro');
        setTimeout(conectarWebSocket, 3000);
    };
    
    socket.onerror = (erro) => {
        console.error('Erro no WebSocket:', erro);
        atualizarStatus(false);
    };
}

function atualizarStatus(conectado) {
    const indicator = document.getElementById('status-indicator');
    const text = document.getElementById('status-text');
    const overlay = document.getElementById('connection-overlay');
    
    if (conectado) {
        indicator.className = 'status-indicator';
        text.textContent = 'Conectado';
        if (overlay) {
            overlay.style.display = 'none';
        }
    } else {
        indicator.className = 'status-indicator disconnected';
        text.textContent = 'Desconectado';
        if (overlay) {
            overlay.style.display = 'flex';
        }
    }
}

// ============================================
// LOGIN
// ============================================
function fazerLogin() {
    console.log('🔑 Botão de login clicado. Iniciando processo...');
    const loginButton = document.getElementById('login-button');
    const usuario = document.getElementById('usuario').value;
    const senha = document.getElementById('senha').value;
    
    if (!usuario || !senha) {
        mostrarNotificacao('Preencha usuário e senha', 'erro');
        return;
    }
    
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        mostrarNotificacao('Ainda conectando ao servidor, por favor aguarde.', 'info');
        return;
    }
    
    loginButton.disabled = true;
    loginButton.textContent = 'Entrando...';
    
    socket.send(JSON.stringify({
        tipo: 'login',
        usuario,
        senha
    }));
}

// ============================================
// GERENCIAMENTO DE APPS
// ============================================
function renderizarIconesDesktop(atalhos) {
    const areaApps = document.getElementById('area-apps');
    
    let iconContainer = document.getElementById('desktop-icons');
    if (!iconContainer) {
        iconContainer = document.createElement('div');
        iconContainer.id = 'desktop-icons';
        areaApps.appendChild(iconContainer);
    }
    iconContainer.innerHTML = '';

    atalhos.forEach(atalho => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'desktop-icon';

        iconDiv.innerHTML = \`
            <div class="icon">\${atalho.icone}</div>
            <div class="name">\${atalho.nome}</div>
        \`;

        if (atalho.app) {
            iconDiv.onclick = () => abrirApp(atalho.app);
        } else if (atalho.caminho) {
            // Extrai o caminho relativo para o file manager
            const caminhoRelativo = atalho.caminho.replace(\`/usuarios/\${usuarioAtual.nome}/\`, '');
            iconDiv.onclick = () => abrirApp('file_manager', { caminho: caminhoRelativo });
        }

        iconContainer.appendChild(iconDiv);
    });
}

function abrirApp(appNome, params = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        mostrarNotificacao('Servidor não conectado', 'erro');
        return;
    }
    
    socket.send(JSON.stringify({
        tipo: 'abrir_app',
        app: appNome,
        params
    }));
}

function adicionarAppAoDock(app) {
    const dock = document.getElementById('dock');
    if (!dock) return;

    // Evita adicionar ícones duplicados
    const existingIcons = dock.querySelectorAll('.dock-icon');
    for (let icon of existingIcons) {
        if (icon.getAttribute('data-tooltip') === app.nome) {
            return; // App já está no dock
        }
    }

    const separator = dock.querySelector('.dock-separator');
    const newIcon = document.createElement('div');
    newIcon.className = 'dock-icon';
    newIcon.setAttribute('data-tooltip', app.nome);
    newIcon.innerHTML = app.icone || '📦';
    newIcon.onclick = () => abrirApp(app.id);

    // Insere o novo ícone antes do separador
    dock.insertBefore(newIcon, separator);
}

function abrirJanelaApp(dados) {
    const { processoId, ui, app, params } = dados;
    const areaApps = document.getElementById('area-apps');
    
    // Cria container da janela
    const janela = document.createElement('div');
    janela.className = 'janela';
    janela.id = \`janela-\${processoId}\`;
    janela.style.left = '100px';
    janela.style.top = '100px';
    janela.style.width = '800px';
    janela.style.height = '600px';
    janela.style.zIndex = proximaZIndex++;
    
    // Processa a UI substituindo placeholders
    let uiProcessada = ui.replace(/{id}/g, processoId);
    
    // Monta HTML da janela
    janela.innerHTML = \`
        <div class="barra-titulo">
            <div class="window-controls">
                <span class="window-control close" onclick="fecharJanela('\${processoId}')"></span>
                <span class="window-control minimize" onclick="minimizarJanela('\${processoId}')"></span>
                <span class="window-control maximize" onclick="maximizarJanela('\${processoId}')"></span>
            </div>
            <div class="window-title">
                <span>\${app.nome}</span>
                <small style="font-size: 10px; opacity: 0.6;">v\${app.versao}</small>
            </div>
        </div>
        <div class="conteudo" id="conteudo-\${processoId}">
            \${uiProcessada}
        </div>
    \`;
    
    areaApps.appendChild(janela);
    
    // Torna a janela arrastável
    tornarArrastavel(janela);
    
    // Traz para frente ao clicar
    janela.addEventListener('mousedown', () => {
        janela.style.zIndex = proximaZIndex++;
    });
    
    // Injeta scripts específicos do app se necessário
    if (app.scripts) {
        app.scripts.forEach(script => {
            const scriptTag = document.createElement('script');
            scriptTag.src = script;
            document.head.appendChild(scriptTag);
        });
    }
    
    // Registra o processo
    processosAbertos.set(processoId, {
        janela,
        app: app.nome,
        estado: {}
    });
    
    // Adiciona ao dock como ativo
    destacarAppNoDock(app.nome);

    // Dispara comando inicial para apps que precisam carregar dados
    switch(app.nome) {
        case 'Visualizador de Fotos':
            enviarComandoApp(processoId, 'listar');
            break;
        case 'App Store':
            // Lista os apps em destaque ao abrir
            enviarComandoApp(processoId, 'listar');
            break;
        case 'Gerenciador de Arquivos':
            const caminhoInicial = params && params.caminho ? params.caminho : '';
            enviarComandoApp(processoId, 'listar', { caminho: caminhoInicial });
            break;
        case 'Tech News':
            atualizarNews(processoId);
            break;
        case 'Gerenciador de Tarefas':
            atualizarTarefas(processoId);
            break;
    }

    // Auto-abrir arquivo se passado nos parâmetros
    if (params && params.arquivo && app.nome === 'Bloco de Notas') {
        socket.send(JSON.stringify({
            tipo: 'ler_arquivo',
            caminho: params.arquivo,
            reqId: processoId
        }));
    }
}

function tornarArrastavel(elemento) {
    let offsetX, offsetY, mouseX, mouseY;
    
    // Agora permite arrastar clicando em qualquer lugar da janela (elemento)
    elemento.addEventListener('mousedown', (e) => {
        // Verifica se o clique NÃO foi em um elemento interativo (botão, input, texto, etc.)
        const target = e.target;
        const tagName = target.tagName.toUpperCase();
        
        if (['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A', 'IFRAME', 'CANVAS', 'VIDEO', 'IMG'].includes(tagName) || 
            target.classList.contains('window-control') ||
            target.isContentEditable ||
            target.closest('.calc-button') || // Exceção para calculadora
            target.closest('.app-item button') // Exceção para botões da loja
           ) {
            return; // Não arrasta se clicou em algo interativo
        }
        
        e.preventDefault();
        mouseX = e.clientX;
        mouseY = e.clientY;
        
        document.onmousemove = (e) => {
            e.preventDefault();
            offsetX = mouseX - e.clientX;
            offsetY = mouseY - e.clientY;
            mouseX = e.clientX;
            mouseY = e.clientY;
            
            let novaTop = elemento.offsetTop - offsetY;
            let novaLeft = elemento.offsetLeft - offsetX;
            
            if (novaTop < 0) novaTop = 0; // Impede que a janela suba além do cabeçalho
            
            elemento.style.top = novaTop + 'px';
            elemento.style.left = novaLeft + 'px';
        };
        
        document.onmouseup = () => {
            document.onmousemove = null;
            document.onmouseup = null;
        };
    });
}

function fecharJanela(processoId) {
    const janela = document.getElementById(\`janela-\${processoId}\`);
    if (janela) {
        janela.remove();
        processosAbertos.delete(processoId);
    }
}

function minimizarJanela(processoId) {
    const janela = document.getElementById(\`janela-\${processoId}\`);
    if (janela) {
        janela.style.display = 'none';
    }
}

function maximizarJanela(processoId) {
    const janela = document.getElementById(\`janela-\${processoId}\`);
    if (janela) {
        janela.classList.toggle('maximized');
    }
}

function destacarAppNoDock(appNome) {
    const icons = document.querySelectorAll('.dock-icon');
    icons.forEach(icon => {
        if (icon.getAttribute('data-tooltip') === appNome) {
            icon.classList.add('active');
        }
    });
}

// ============================================
// COMANDOS DOS APPS
// ============================================
function enviarComandoApp(processoId, comando, args = {}, callback = null) {
    if (callback) {
        pendingCallbacks.set(processoId, callback);
    }
    socket.send(JSON.stringify({
        tipo: 'comando_app',
        processoId,
        comando,
        args
    }));
}

function processarResultadoComando(dados) {
    const { processoId, comando, resultado, app } = dados;
    
    if (pendingCallbacks.has(processoId)) {
        const callback = pendingCallbacks.get(processoId);
        callback(resultado);
        pendingCallbacks.delete(processoId);
        return;
    }
    
    // Roteia para o handler específico do app
    switch(app) {
        case 'calculadora':
            processarResultadoCalculadora(processoId, resultado);
            break;
        case 'terminal':
            processarResultadoTerminal(processoId, resultado);
            break;
        case 'fotos':
            processarResultadoFotos(processoId, resultado);
            break;
        case 'task_manager':
            processarResultadoTaskManager(processoId, resultado);
            break;
        case 'app_store':
            processarResultadoAppStore(processoId, resultado);
            break;
        case 'game_center':
            processarResultadoGameCenter(processoId, resultado);
            break;
        case 'file_manager':
            processarResultadoFileManager(processoId, resultado);
            break;
    }
}

// ============================================
// APP: PAINT (CORREÇÃO initPaint)
// ============================================
window.initPaint = function(processoId, btn) {
    const canvas = document.getElementById(\`canvas-\${processoId}\`);
    const colorPicker = document.getElementById(\`paint-color-\${processoId}\`);
    const sizePicker = document.getElementById(\`paint-size-\${processoId}\`);
    
    if (!canvas) return;
    
    // Oculta o botão após iniciar
    if(btn) btn.style.display = 'none';
    
    const ctx = canvas.getContext('2d');
    
    // Ajusta tamanho do canvas
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height - 50; // Altura da toolbar
    
    let painting = false;
    
    function startPosition(e) {
        painting = true;
        draw(e);
    }
    
    function endPosition() {
        painting = false;
        ctx.beginPath();
    }
    
    function draw(e) {
        if (!painting) return;
        
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX || e.touches[0].clientX) - rect.left;
        const y = (e.clientY || e.touches[0].clientY) - rect.top;
        
        ctx.lineWidth = sizePicker.value;
        ctx.lineCap = 'round';
        ctx.strokeStyle = colorPicker.value;
        
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
    }
    
    canvas.addEventListener('mousedown', startPosition);
    canvas.addEventListener('mouseup', endPosition);
    canvas.addEventListener('mousemove', draw);
};

// ============================================
// APP: CALCULADORA
// ============================================
window.calc = function(processoId, valor) {
    enviarComandoApp(processoId, valor, {
        estado: processosAbertos.get(processoId)?.estado
    });
};

function processarResultadoCalculadora(processoId, resultado) {
    const display = document.getElementById(\`display-\${processoId}\`);
    if (display && resultado.display !== undefined) {
        display.textContent = resultado.display;
    }
    
    // Atualiza estado
    const processo = processosAbertos.get(processoId);
    if (processo) {
        processo.estado = resultado;
    }
}

// ============================================
// APP: GERENCIADOR DE ARQUIVOS
// ============================================
window.fmPesquisar = function(processoId) {
    const input = document.getElementById('fm-search-' + processoId);
    const termo = input.value;
    const pathInput = document.getElementById('fm-path-' + processoId);
    const caminhoAtual = pathInput.getAttribute('data-path') || '';
    
    enviarComandoApp(processoId, 'pesquisar', { termo: termo, caminho: caminhoAtual });
};

window.fmNavegar = function(processoId, destino) {
    const input = document.getElementById('fm-path-' + processoId);
    let atual = input.getAttribute('data-path') || '';
    
    let novoCaminho = atual;
    
    if (destino === '..') {
        if (!atual) return; // Já está na raiz
        const partes = atual.split('/');
        partes.pop();
        novoCaminho = partes.join('/');
    } else {
        novoCaminho = destino;
    }
    
    enviarComandoApp(processoId, 'listar', { caminho: novoCaminho });
};

window.fmAtualizar = function(processoId) {
    const input = document.getElementById('fm-path-' + processoId);
    const atual = input.getAttribute('data-path') || '';
    enviarComandoApp(processoId, 'listar', { caminho: atual });
};

window.fmAbrirItem = function(processoId, tipo, caminho) {
    if (tipo === 'directory') {
        fmNavegar(processoId, caminho);
    } else if (tipo === 'text/plain' || tipo === 'application/json' || tipo.includes('text') || tipo.includes('javascript') || tipo.includes('xml') || tipo.includes('html')) {
        // Abre arquivos de texto diretamente no Bloco de Notas
        abrirApp('bloco_notas', { arquivo: caminho });
    } else {
        mostrarNotificacao('Arquivo: ' + caminho, 'info');
    }
};

function processarResultadoFileManager(processoId, resultado) {
    const lista = document.getElementById('fm-lista-' + processoId);
    const pathInput = document.getElementById('fm-path-' + processoId);
    
    if (!lista || !resultado.arquivos) return;

    if (resultado.isPesquisa) {
        pathInput.value = resultado.caminhoAtual;
    } else {
        pathInput.value = '/' + (resultado.caminhoAtual || '');
        pathInput.setAttribute('data-path', resultado.caminhoAtual);
    }

    if (resultado.arquivos.length === 0) {
        lista.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:var(--text-secondary); padding:20px;">' + (resultado.isPesquisa ? 'Nenhum resultado encontrado.' : 'Pasta vazia') + '</div>';
    } else {
        lista.innerHTML = resultado.arquivos.map(arq => {
            const itemHtml =
                '<div onclick="fmAbrirItem(\\'' + processoId + '\\', \\'' + arq.tipo + '\\', \\'' + arq.caminho + '\\')" ' +
                'style="display:flex; flex-direction:column; align-items:center; padding:10px; cursor:pointer; border-radius:var(--radius-md); transition:background 0.2s;" ' +
                'onmouseover="this.style.background=\\'var(--bg-secondary)\\'" onmouseout="this.style.background=\\'transparent\\'">' +
                    '<div style="font-size:2.5rem; margin-bottom:5px;">' + arq.icone + '</div>' +
                    '<div style="font-size:0.85rem; text-align:center; word-break:break-word;">' + arq.nome + '</div>';

            if (resultado.isPesquisa && arq.contexto && arq.contexto !== '.') {
                return itemHtml + '<div style="font-size:0.7rem; color:var(--text-tertiary); text-align:center;">em ' + (arq.contexto || '/') + '</div></div>';
            }

            return itemHtml + '</div>';
        }).join('');
    }
}

// ============================================
// APP: BLOCO DE NOTAS
// ============================================
window.notas = function(processoId, acao) {
    const textarea = document.getElementById(\`texto-\${processoId}\`);
    const status = document.getElementById(\`status-\${processoId}\`);
    
    switch(acao) {
        case 'novo':
            textarea.value = '';
            atualizarStatusNotas(processoId);
            break;
            
        case 'salvar':
            mostrarSeletorArquivo('salvar', (caminho) => {
                const conteudoBase64 = btoa(unescape(encodeURIComponent(textarea.value)));
                socket.send(JSON.stringify({
                    tipo: 'salvar_arquivo',
                    caminho: caminho,
                    conteudo: conteudoBase64,
                    formato: 'text/plain'
                }));
            });
            break;
            
        case 'abrir':
            mostrarSeletorArquivo('abrir', (caminho) => {
                socket.send(JSON.stringify({
                    tipo: 'ler_arquivo',
                    caminho: caminho,
                    reqId: processoId
                }));
            });
            break;
            
        case 'copiar':
            navigator.clipboard.writeText(textarea.value).then(() => {
                mostrarNotificacao('Texto copiado!', 'sucesso');
            });
            break;
            
        case 'colar':
            navigator.clipboard.readText().then(texto => {
                textarea.value += texto;
                atualizarStatusNotas(processoId);
            });
            break;
    }
    
    // Atualiza status ao digitar
    textarea.addEventListener('input', () => atualizarStatusNotas(processoId));
};

function atualizarStatusNotas(processoId) {
    const textarea = document.getElementById(\`texto-\${processoId}\`);
    const status = document.getElementById(\`status-\${processoId}\`);
    
    if (textarea && status) {
        const linhas = textarea.value.split('\\n').length;
        const palavras = textarea.value.trim().split(/\\s+/).filter(p => p).length;
        status.textContent = \`Linhas: \${linhas} | Palavras: \${palavras} | Caracteres: \${textarea.value.length}\`;
    }
}

// Novo Seletor de Arquivos Unificado (Estilo File Manager)
function mostrarSeletorArquivo(modo, callback) {
    const seletorId = 'seletor-' + Date.now();
    const titulo = modo === 'abrir' ? '📂 Abrir Arquivo' : '💾 Salvar Arquivo';
    
    const janela = document.createElement('div');
    janela.className = 'janela';
    janela.id = seletorId;
    janela.style.width = '500px';
    janela.style.height = '400px';
    janela.style.left = 'calc(50% - 250px)';
    janela.style.top = 'calc(50% - 200px)';
    janela.style.zIndex = proximaZIndex++;
    
    // HTML Estrutural do Seletor
    janela.innerHTML = 
        '<div class="barra-titulo">' +
            '<div class="window-title">' + titulo + '</div>' +
            '<div class="window-controls">' +
                '<span class="window-control close" onclick="document.getElementById(\\'' + seletorId + '\\').remove()"></span>' +
            '</div>' +
        '</div>' +
        '<div class="conteudo" style="display:flex; flex-direction:column; height:calc(100% - 45px); background:var(--bg-primary);">' +
            '<div style="padding:10px; background:var(--bg-tertiary); border-bottom:1px solid var(--border-light); display:flex; gap:10px; align-items:center;">' +
                '<button id="btn-voltar-' + seletorId + '" style="cursor:pointer; padding:5px 10px; border-radius:4px; border:1px solid var(--border-light);">⬆️</button>' +
                '<input type="text" id="path-' + seletorId + '" value="" readonly style="flex:1; padding:5px; border-radius:4px; border:1px solid var(--border-light); background:var(--bg-secondary); color:var(--text-primary);">' +
            '</div>' +
            '<div id="lista-' + seletorId + '" style="flex:1; overflow-y:auto; padding:10px; display:grid; grid-template-columns:repeat(auto-fill, minmax(90px, 1fr)); gap:10px; align-content:start;">' +
                'Carregando...' +
            '</div>' +
            '<div style="padding:15px; background:var(--bg-tertiary); border-top:1px solid var(--border-light); display:flex; gap:10px; align-items:center;">' +
                '<span style="font-size:0.9em;">Nome:</span>' +
                '<input type="text" id="input-nome-' + seletorId + '" value="' + (modo === 'salvar' ? 'nota.txt' : '') + '" style="flex:1; padding:6px; border:1px solid var(--border-light); border-radius:4px;">' +
                '<button id="btn-acao-' + seletorId + '" style="padding:6px 15px; background:var(--accent); color:white; border:none; border-radius:4px; cursor:pointer;">' +
                    (modo === 'abrir' ? 'Abrir' : 'Salvar') +
                '</button>' +
                '<button onclick="document.getElementById(\\'' + seletorId + '\\').remove()" style="padding:6px 15px; background:var(--bg-secondary); border:1px solid var(--border-light); border-radius:4px; cursor:pointer;">Cancelar</button>' +
            '</div>' +
        '</div>';
    
    document.getElementById('area-apps').appendChild(janela);
    tornarArrastavel(janela);
    
    // Lógica de Navegação
    const navegar = (caminho) => {
        socket.send(JSON.stringify({
            tipo: 'listar_arquivos',
            pasta: caminho,
            reqId: seletorId
        }));
    };
    
    // Callback para atualizar a lista
    seletorCallbacks.set(seletorId, (dados) => {
        const lista = document.getElementById('lista-' + seletorId);
        const pathInput = document.getElementById('path-' + seletorId);
        const btnVoltar = document.getElementById('btn-voltar-' + seletorId);
        
        const caminhoAtual = dados.caminho || '';
        pathInput.value = '/' + caminhoAtual;
        
        // Configura botão voltar
        btnVoltar.onclick = () => {
            if (!caminhoAtual) return;
            const partes = caminhoAtual.split('/');
            partes.pop();
            navegar(partes.join('/'));
        };
        
        // Filtra para mostrar apenas os filhos diretos do diretório atual
        const arquivosFiltrados = dados.arquivos.filter(arq => {
            const caminhoRelativo = arq.caminho_relativo;
            // Obtém o diretório pai do item, ou uma string vazia se estiver na raiz
            const dirPai = caminhoRelativo.includes('/') ? caminhoRelativo.substring(0, caminhoRelativo.lastIndexOf('/')) : '';
            return dirPai === caminhoAtual;
        });
        
        if (arquivosFiltrados.length === 0) {
            lista.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:var(--text-secondary); padding:20px;">Pasta vazia</div>';
        } else {
            lista.innerHTML = arquivosFiltrados.map((arq, index) => {
                const isDir = arq.tipo === 'directory';
                const icon = isDir ? '📁' : '📄';
                
                return (
                    '<div id="item-' + seletorId + '-' + index + '"' +
                        ' style="display:flex; flex-direction:column; align-items:center; padding:10px; cursor:pointer; border-radius:var(--radius-md); transition:background 0.2s;"' + 
                        ' onmouseover="this.style.background=\\'var(--bg-secondary)\\'" onmouseout="this.style.background=\\'transparent\\'">' +
                        '<div style="font-size:2rem; margin-bottom:5px;">' + icon + '</div>' +
                        '<div style="font-size:0.8rem; text-align:center; word-break:break-word;">' + arq.nome + '</div>' +
                    '</div>'
                );
            }).join('');
            
            // Adiciona listeners seguros (evita problemas com aspas no nome)
            arquivosFiltrados.forEach((arq, index) => {
                const item = document.getElementById('item-' + seletorId + '-' + index);
                if (arq.tipo === 'directory') {
                    item.onclick = () => navegar(arq.caminho_relativo);
                } else {
                    item.onclick = () => {
                        document.getElementById('input-nome-' + seletorId).value = arq.nome;
                    };
                }
            });
        }
    });
    
    // Ação Principal (Botão Abrir/Salvar)
    document.getElementById('btn-acao-' + seletorId).onclick = () => {
        const pathAtual = document.getElementById('path-' + seletorId).value; // Ex: '/Documentos'
        const nomeArquivo = document.getElementById('input-nome-' + seletorId).value;
        
        if (!nomeArquivo) {
            mostrarNotificacao('Digite um nome de arquivo', 'erro');
            return;
        }
        
        // Remove a barra inicial para a lógica de junção de caminho
        let basePath = pathAtual.startsWith('/') ? pathAtual.substring(1) : pathAtual;
        
        const caminhoCompleto = basePath ? basePath + '/' + nomeArquivo : nomeArquivo;
        callback(caminhoCompleto);
        document.getElementById(seletorId).remove();
        seletorCallbacks.delete(seletorId);
    };
    
    // Inicia na raiz ou Documentos
    navegar('Documentos');
}

// ============================================
// APP: TERMINAL
// ============================================
window.term = function(processoId, comando, inputElement) {
    enviarComandoApp(processoId, comando, {
        estado: processosAbertos.get(processoId)?.estado
    });
    
    // Limpa input
    inputElement.value = '';
};

function processarResultadoTerminal(processoId, resultado) {
    const terminal = document.getElementById(\`conteudo-\${processoId}\`);
    if (!terminal) return;
    
    const output = terminal.querySelector('.terminal-output');
    const input = terminal.querySelector('input');
    
    if (resultado.clear) {
        output.innerHTML = 'WebOS Terminal [Versão 1.0]<br>(c) 2026 WebOS Corp. Todos os direitos reservados.<br><br>';
        return;
    }
    
    if (resultado.output !== undefined) {
        // Adiciona comando anterior
        const ultimaLinha = output.innerHTML.split('<br>').pop();
        if (!ultimaLinha.includes('demo@webos')) {
            output.innerHTML += \`<div><span style="color:#81c784;">demo@webos:~$</span> \${input?.value || ''}</div>\`;
        }
        
        // Adiciona resultado
        output.innerHTML += \`<div>\${resultado.output}</div>\`;
    }
    
    // Atualiza estado
    const processo = processosAbertos.get(processoId);
    if (processo) {
        processo.estado = resultado;
    }
    
    // Scroll para o final
    output.scrollTop = output.scrollHeight;
}

// ============================================
// APP: NAVEGADOR
// ============================================
window.navegar = function(processoId) {
    const url = document.getElementById(\`url-\${processoId}\`).value;
    const frame = document.getElementById(\`frame-\${processoId}\`);
    
    // Garante que a URL tenha protocolo
    let urlFinal = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        urlFinal = 'https://' + url;
    }
    
    frame.src = urlFinal;
};

// ============================================
// APP: APP STORE
// ============================================
window.buscarApps = function(processoId) {
    const termo = document.getElementById(\`app-busca-\${processoId}\`).value;
    
    if (!termo) {
        // Lista todos os apps disponíveis
        enviarComandoApp(processoId, 'listar');
    } else {
        // Busca por termo
        enviarComandoApp(processoId, 'buscar_apps', { termo });
    }
};

function processarResultadoAppStore(processoId, resultado) {
    const container = document.getElementById(\`lista-apps-store-\${processoId}\`);
    if (!container) return;
    
    if (resultado.apps) {
        container.innerHTML = resultado.apps.map(function(app) {
            return (
                '<div class="app-item">' +
                    '<div class="app-item-info">' +
                        '<strong>' + app.nome + '</strong>' +
                        '<span>v' + app.versao + '</span>' +
                    '</div>' +
                    '<button onclick="instalarApp(\\'' + processoId + '\\', \\'' + app.id + '\\')">' +
                        '📥 Instalar' +
                    '</button>' +
                '</div>'
            );
        }).join('');
    }
    
    if (resultado.apps_encontrados) {
        if (resultado.apps_encontrados.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:20px; color:#888;">Nenhum app encontrado.</p>';
        } else {
            container.innerHTML = resultado.apps_encontrados.map(function(app) {
                var descHtml = app.descricao ? '<span style="color:#888;">' + app.descricao.substring(0, 50) + '...</span>' : '';
                return (
                    '<div class="app-item">' +
                        '<div class="app-item-info">' +
                            '<strong>' + app.nome + '</strong>' +
                            '<span>v' + app.versao + '</span>' +
                            descHtml +
                        '</div>' +
                        '<button onclick="instalarApp(\\'' + processoId + '\\', \\'' + app.id + '\\')">' +
                            '📥 Instalar' +
                        '</button>' +
                    '</div>'
                );
            }).join('');
        }
    }
}

window.instalarApp = function(processoId, appId) {
    socket.send(JSON.stringify({
        tipo: 'instalar_app',
        appId
    }));
    
    // Feedback visual
    mostrarNotificacao(\`Instalando \${appId}...\`, 'info');
};

// ============================================
// APP: CRYPTO TRACKER
// ============================================
window.atualizarCrypto = async function(processoId) {
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'atualizar', {}, resolve);
    });
    
    const container = document.getElementById(\`crypto-list-\${processoId}\`);
    if (!container) return;
    
    if (resultado.erro) {
        container.innerHTML = \`<p style="color: #e94560;">Erro: \${resultado.erro}</p>\`;
        return;
    }
    
    if (resultado.precos) {
        const cryptos = {
            bitcoin: { nome: 'Bitcoin', icone: '₿' },
            ethereum: { nome: 'Ethereum', icone: 'Ξ' },
            solana: { nome: 'Solana', icone: '◎' },
            dogecoin: { nome: 'Dogecoin', icone: 'Ð' }
        };
        
        container.innerHTML = Object.entries(resultado.precos).map(([id, precos]) => \`
            <div style="margin-bottom: 15px; padding: 10px; background: #16213e; border-radius: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 1.2em;">\${cryptos[id]?.icone || '🪙'} \${cryptos[id]?.nome || id}</span>
                    <span style="font-weight: bold;">$\${precos.usd.toLocaleString()}</span>
                </div>
                <div style="color: #888; margin-top: 5px;">R$ \${precos.brl.toLocaleString()}</div>
            </div>
        \`).join('');
    }
};

// ============================================
// APP: CLIMA
// ============================================
window.buscarClima = async function(processoId) {
    const cidade = document.getElementById(\`cidade-\${processoId}\`).value;
    if (!cidade) return;
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'buscar', { cidade }, resolve);
    });
    
    const container = document.getElementById(\`resultado-clima-\${processoId}\`);
    if (!container) return;
    
    if (resultado.erro) {
        container.innerHTML = \`<p style="color: #ff6b6b;">Erro: \${resultado.erro}</p>\`;
        return;
    }
    
    if (resultado.clima) {
        const { temperatura, windspeed, weathercode } = resultado.clima;
        const { name, country } = resultado.local;
        
        // Códigos de tempo da Open-Meteo
        const weatherCodes = {
            0: { icon: '☀️', desc: 'Céu limpo' },
            1: { icon: '🌤️', desc: 'Parcialmente nublado' },
            2: { icon: '⛅', desc: 'Parcialmente nublado' },
            3: { icon: '☁️', desc: 'Nublado' },
            45: { icon: '🌫️', desc: 'Neblina' },
            48: { icon: '🌫️', desc: 'Nevoeiro' },
            51: { icon: '🌧️', desc: 'Chuva fraca' },
            61: { icon: '🌧️', desc: 'Chuva' },
            80: { icon: '🌦️', desc: 'Pancadas de chuva' },
            95: { icon: '⛈️', desc: 'Tempestade' }
        };
        
        const weather = weatherCodes[weathercode] || { icon: '🌡️', desc: 'Desconhecido' };
        
        container.innerHTML = \`
            <div style="font-size: 4em; margin-bottom: 10px;">\${weather.icon}</div>
            <div style="font-size: 3em; font-weight: bold;">\${temperatura}°C</div>
            <div style="font-size: 1.5em; margin: 10px 0;">\${name}, \${country}</div>
            <div style="color: #ddd;">\${weather.desc}</div>
            <div style="margin-top: 20px;">💨 Vento: \${windspeed} km/h</div>
        \`;
    }
};

// ============================================
// APP: WIKIPEDIA
// ============================================
window.buscarWiki = async function(processoId) {
    const termo = document.getElementById(\`wiki-busca-\${processoId}\`).value;
    if (!termo) return;
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'buscar', { termo }, resolve);
    });
    
    const container = document.getElementById(\`wiki-conteudo-\${processoId}\`);
    if (!container) return;
    
    if (resultado.erro) {
        container.innerHTML = \`<p style="color: #e94560;">Erro: \${resultado.erro}</p>\`;
        return;
    }
    
    if (resultado.busca && resultado.busca.length > 0) {
        container.innerHTML = resultado.busca.map(item => \`
            <div onclick="lerWiki('\${processoId}', \${item.pageid})" style="padding: 10px; margin: 5px 0; background: #f9f9f9; cursor: pointer; border-radius: 5px;">
                <h4>\${item.title}</h4>
                <p style="color: #666; font-size: 0.9em;">\${item.snippet.replace(/<[^>]*>/g, '')}...</p>
            </div>
        \`).join('');
    } else {
        container.innerHTML = '<p>Nenhum resultado encontrado.</p>';
    }
};

window.lerWiki = async function(processoId, pageid) {
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'ler', { pageid }, resolve);
    });
    
    const container = document.getElementById(\`wiki-conteudo-\${processoId}\`);
    if (!container) return;
    
    if (resultado.conteudo) {
        container.innerHTML = \`
            <h2>\${resultado.titulo}</h2>
            <div style="font-size: 0.9em; line-height: 1.6;">
                \${resultado.conteudo}
            </div>
            <button onclick="buscarWiki('\${processoId}')" style="margin-top: 20px;">← Voltar</button>
        \`;
    }
};

// ============================================
// APP: TECH NEWS (HACKER NEWS)
// ============================================
window.atualizarNews = async function(processoId) {
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'listar', {}, resolve);
    });
    
    const container = document.getElementById(\`news-lista-\${processoId}\`);
    if (!container) return;
    
    if (resultado.noticias) {
        container.innerHTML = resultado.noticias.map((item, index) => \`
            <div style="margin-bottom: 15px; padding: 10px; background: #ffffff; border-radius: 5px; border-left: 3px solid #ff6600;">
                <div style="display: flex; gap: 10px;">
                    <span style="color: #ff6600; font-weight: bold;">\${index + 1}.</span>
                    <div>
                        <a href="\${item.url || '#'}" target="_blank" style="color: #000; text-decoration: none; font-weight: bold;">\${item.title}</a>
                        <div style="font-size: 0.8em; color: #666; margin-top: 5px;">
                            \${item.points} pontos | por \${item.author} | \${item.created_at ? new Date(item.created_at).toLocaleDateString() : ''}
                        </div>
                    </div>
                </div>
            </div>
        \`).join('');
    }
};

// ============================================
// APP: GAME CENTER
// ============================================
window.buscarJogos = async function(processoId) {
    const termo = document.getElementById(\`game-busca-\${processoId}\`).value;
    if (!termo) return;
    
    const container = document.getElementById(\`game-resultados-\${processoId}\`);
    container.innerHTML = '<p style="color: #888;">Buscando jogos no Internet Archive...</p>';
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'buscar_jogos', { termo }, resolve);
    });
    
    if (resultado.jogos && resultado.jogos.length > 0) {
        container.innerHTML = resultado.jogos.map(jogo => \`
            <div class="game-card">
                <div class="game-info">
                    <h4>\${jogo.title}</h4>
                    <span>Sistema: \${jogo.system.toUpperCase()}</span>
                </div>
                <button class="play-button" onclick="jogarGame('\${processoId}', '\${jogo.system}', '\${jogo.romUrl}')">
                    ▶️ Jogar
                </button>
            </div>
        \`).join('');
    } else {
        container.innerHTML = \`
            <p style="text-align:center; color:#888;">Nenhum jogo encontrado. Tente outro termo.</p>
            <p style="text-align:center; font-size:0.8em; color:#666;">Dica: Busque por "Super Mario", "Zelda", "Metroid", etc.</p>
        \`;
    }
};

window.carregarJogoLocal = function(processoId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sfc,.smc,.nes,.gba,.gbc';
    
    input.onchange = (e) => {
        const file = e.target.files[0];
        const extension = file.name.split('.').pop().toLowerCase();
        
        let sistema = 'snes';
        if (extension === 'nes') sistema = 'nes';
        if (extension === 'gba') sistema = 'gba';
        if (extension === 'gbc') sistema = 'gbc';
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const url = URL.createObjectURL(file);
            jogarGame(processoId, sistema, url);
        };
        reader.readAsArrayBuffer(file);
    };
    
    input.click();
};

window.jogarGame = function(processoId, sistema, romUrl) {
    let appNome;
    switch(sistema) {
        case 'nes':
            appNome = 'nes_emulator';
            break;
        case 'gba':
            appNome = 'gba_emulator';
            break;
        case 'snes':
        default:
            appNome = 'snes_emulator';
            break;
    }
    
    // Abre o emulador em uma nova janela
    abrirApp(appNome, { romUrl });
};

// ============================================
// APP: ANDROID EMULATOR (APPETIZE)
// ============================================
window.buscarApkAppetize = async function(processoId) {
    const termo = document.getElementById(\`android-busca-\${processoId}\`).value;
    if (!termo) return;
    
    const lista = document.getElementById(\`android-lista-\${processoId}\`);
    lista.style.display = 'block';
    lista.innerHTML = '<div style="padding:10px; color:#ccc;">Buscando...</div>';
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'buscar', { termo }, resolve);
    });
    
    if (resultado.resultados && resultado.resultados.length > 0) {
        lista.innerHTML = resultado.resultados.map(app => \`
            <div onclick="rodarApkAppetize('\${processoId}', '\${app.apkUrl}')" style="padding:10px; border-bottom:1px solid #333; cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
                <span style="font-weight:bold; color:white;">\${app.title}</span>
                <button style="background:#3ddc84; border:none; border-radius:3px; padding:5px 10px; cursor:pointer;">▶️ Play</button>
            </div>
        \`).join('');
    } else {
        lista.innerHTML = '<div style="padding:10px; color:#ccc;">Nenhum APK encontrado.</div>';
    }
};

window.rodarApkAppetize = async function(processoId, url) {
    const container = document.getElementById(\`android-container-\${processoId}\`);
    const lista = document.getElementById(\`android-lista-\${processoId}\`);
    
    lista.style.display = 'none'; // Esconde a lista
    
    container.innerHTML = '<p style="color:white;">Processando APK na nuvem...</p>';
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'instalar', { url }, resolve);
    });
    
    if (resultado.erro) {
        container.innerHTML = \`<div style="text-align:center; color:#ff5f57;"><p>Erro:</p><p>\${resultado.erro}</p></div>\`;
        return;
    }
    
    if (resultado.publicKey) {
        container.innerHTML = \`
            <iframe src="https://appetize.io/embed/\${resultado.publicKey}?device=pixel4&scale=75&autoplay=true&orientation=portrait&deviceColor=black" 
            width="375px" height="812px" frameborder="0" scrolling="no" 
            style="border:none; box-shadow: 0 0 20px rgba(0,0,0,0.5);"></iframe>
            <iframe src="https://appetize.io/embed/\${resultado.publicKey}?device=none&scale=75&autoplay=true&orientation=portrait&xdocMsg=true" 
            width="100%" height="100%" frameborder="0" scrolling="no" 
            style="border:none; background: #000;"></iframe>
        \`;
    }
};

// ============================================
// APP: TASK MANAGER
// ============================================
window.atualizarTarefas = function(processoId) {
    enviarComandoApp(processoId, 'listar');
};

function processarResultadoTaskManager(processoId, resultado) {
    const container = document.getElementById(\`lista-tarefas-\${processoId}\`);
    if (!container) return;
    
    if (resultado.processos) {
        if (resultado.processos.length === 0) {
            container.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">Nenhum processo em execução.</td></tr>';
        } else {
            container.innerHTML = resultado.processos.map(proc => \`
                <tr>
                    <td style="padding:8px;">\${proc.nome}</td>
                    <td style="padding:8px;">\${proc.pid.substring(0, 8)}</td>
                    <td style="padding:8px;">\${proc.cpu}</td>
                    <td style="padding:8px;">\${proc.memoria}</td>
                    <td style="padding:8px;">
                        <button class="kill-button" onclick="matarProcesso('\${processoId}', '\${proc.pid}')">Finalizar</button>
                    </td>
                </tr>
            \`).join('');
        }
    }
}

window.matarProcesso = function(processoId, pid) {
    enviarComandoApp(processoId, 'matar', { pid });
    setTimeout(() => atualizarTarefas(processoId), 500);
};

// ============================================
// APP: CLIPBOARD VIEWER
// ============================================
window.atualizarClipboard = function(processoId) {
    const textarea = document.getElementById(\`clipboard-content-\${processoId}\`);
    if (textarea) {
        textarea.value = clipboard || '(vazio)';
    }
};

window.limparClipboard = function(processoId) {
    clipboard = '';
    atualizarClipboard(processoId);
};

// ============================================
// APP: PHOTOPEA
// ============================================
window.carregarArquivoPhotopea = function(processoId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.psd,.png,.jpg,.jpeg,.gif,.bmp,.tiff';
    
    input.onchange = (e) => {
        const file = e.target.files[0];
        const url = URL.createObjectURL(file);
        
        // Tenta enviar para o Photopea via postMessage
        const iframe = document.getElementById(\`frame-photopea-\${processoId}\`);
        iframe.contentWindow.postMessage({
            type: 'open-file',
            url: url,
            name: file.name
        }, '*');
    };
    
    input.click();
};

// ============================================
// APP: VS CODE WEB
// ============================================
window.buscarRepos = async function(processoId) {
    const termo = document.getElementById(\`repo-busca-\${processoId}\`).value;
    if (!termo) return;
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'buscar_repos', { termo }, resolve);
    });
    
    const lista = document.getElementById(\`repo-lista-\${processoId}\`);
    if (resultado.repos) {
        lista.style.display = 'block';
        lista.innerHTML = resultado.repos.map(repo => \`
            <div onclick="abrirRepo('\${processoId}', '\${repo.html_url}')" style="padding: 8px; border-bottom: 1px solid #333; cursor: pointer;">
                <strong>\${repo.full_name}</strong>
                <div style="font-size: 0.8em; color: #888;">\${repo.description || ''}</div>
            </div>
        \`).join('');
    }
};

window.abrirRepo = function(processoId, url) {
    const iframe = document.getElementById(\`frame-vscode-\${processoId}\`);
    iframe.src = \`https://vscode.dev/github/\${url.replace('https://github.com/', '')}\`;
    
    const lista = document.getElementById(\`repo-lista-\${processoId}\`);
    lista.style.display = 'none';
};

// ============================================
// APP: WINDOWS 98 EMULATOR
// ============================================
window.carregarDiscoWin98 = function(processoId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.iso,.img,.bin';
    
    input.onchange = (e) => {
        const file = e.target.files[0];
        const url = URL.createObjectURL(file);
        
        const iframe = document.getElementById(\`frame-win98-\${processoId}\`);
        iframe.contentWindow.postMessage({
            type: 'insert-disk',
            url: url,
            name: file.name
        }, '*');
    };
    
    input.click();
};

window.buscarSoftware = async function(processoId) {
    const termo = document.getElementById(\`soft-busca-\${processoId}\`).value;
    if (!termo) return;
    
    const resultado = await new Promise(resolve => {
        enviarComandoApp(processoId, 'buscar_software', { termo }, resolve);
    });
    
    const lista = document.getElementById(\`soft-lista-\${processoId}\`);
    if (resultado.software) {
        lista.style.display = 'block';
        lista.innerHTML = resultado.software.map(soft => \`
            <div onclick="carregarSoftware('\${processoId}', '\${soft.isoUrl}')" style="padding: 8px; border-bottom: 1px solid #888; cursor: pointer;">
                <strong>\${soft.title}</strong>
            </div>
        \`).join('');
    }
};

window.carregarSoftware = function(processoId, isoUrl) {
    const iframe = document.getElementById(\`frame-win98-\${processoId}\`);
    iframe.contentWindow.postMessage({
        type: 'insert-disk',
        url: isoUrl
    }, '*');
    
    const lista = document.getElementById(\`soft-lista-\${processoId}\`);
    lista.style.display = 'none';
};

// ============================================
// APP: FOTOS
// ============================================
function processarResultadoFotos(processoId, resultado) {
    const galeria = document.getElementById(\`galeria-\${processoId}\`);
    if (!galeria) return;
    
    if (Array.isArray(resultado)) {
        // Lista de fotos
        if (resultado.length === 0) {
            galeria.innerHTML = '<p style="color: #888; text-align: center; padding: 20px;">Nenhuma foto encontrada.</p>';
        } else {
            galeria.innerHTML = resultado.map(foto => \`
                <div class="miniatura" onclick="verFoto('\${processoId}', '\${foto.nome}')">
                    \${foto.nome}
                </div>
            \`).join('');
        }
    } else if (resultado.dados) {
        // Visualização de foto
        galeria.innerHTML = \`
            <div style="position: relative; height: 100%;">
                <img src="\${resultado.dados}" style="max-width: 100%; max-height: 100%; object-fit: contain;">
                <button onclick="voltarFotos('\${processoId}')" style="position: absolute; top: 10px; left: 10px;">← Voltar</button>
            </div>
        \`;
    }
}

window.verFoto = function(processoId, nome) {
    enviarComandoApp(processoId, 'ver', { foto: nome });
};

window.voltarFotos = function(processoId) {
    enviarComandoApp(processoId, 'listar');
};

// ============================================
// UTILITÁRIOS
// ============================================
function mostrarNotificacao(mensagem, tipo = 'info') {
    const container = document.getElementById('notificacoes');
    const notificacao = document.createElement('div');
    notificacao.className = \`notificacao \${tipo}\`;
    notificacao.textContent = mensagem;
    
    container.appendChild(notificacao);
    
    setTimeout(() => {
        notificacao.style.animation = 'notificationSlide 0.3s reverse';
        setTimeout(() => notificacao.remove(), 300);
    }, 3000);
}

function atualizarListaApps(apps) {
    console.log('Apps disponíveis:', apps);
}

function mostrarSobre() {
    mostrarNotificacao(
        'WebOS v1.0\\nUm sistema operacional web completo\\nDesenvolvido com Node.js e WebSocket',
        'info'
    );
}

// ============================================
// TEMA E RELÓGIO
// ============================================
function alternarTema(tema) {
    document.documentElement.setAttribute('data-theme', tema);
    localStorage.setItem('webos-theme', tema);
    
    // Atualiza botões ativos
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.theme === tema) {
            btn.classList.add('active');
        }
    });
}

function atualizarRelogio() {
    const agora = new Date();
    const horas = agora.getHours().toString().padStart(2, '0');
    const minutos = agora.getMinutes().toString().padStart(2, '0');
    document.getElementById('relogio-menu').textContent = \`\${horas}:\${minutos}\`;
}

// ============================================
// INICIALIZAÇÃO
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Validação crucial: Verifica se o arquivo foi aberto via 'file://' em vez de ser servido por HTTP.
    // Este é um erro comum do usuário.
    if (window.location.protocol === 'file:') {
        var html = '<div style="font-family: sans-serif; padding: 40px; background: #fff3f3; border: 2px solid #ffc0c0; color: #a00; height: 100vh; display: flex; justify-content: center; align-items: center;">' +
            '<div style="max-width: 800px;">' +
                '<h1 style="font-size: 2rem; margin-bottom: 20px;">❌ Erro de Acesso</h1>' +
                '<p style="font-size: 1.2rem; line-height: 1.6;"><strong>Você não pode abrir este arquivo diretamente no navegador.</strong> Este é um arquivo de servidor.</p>' +
                '<p style="font-size: 1.2rem; line-height: 1.6; margin-top: 20px;">Para executar o WebOS, siga estes passos:</p>' +
                '<ol style="margin-left: 20px; margin-top: 10px; font-size: 1.2rem; line-height: 1.6;">' +
                    '<li>Abra o terminal (prompt de comando) na pasta onde o arquivo do servidor está salvo.</li>' +
                    '<li>Execute o comando: <code style="background: #eee; padding: 3px 6px; border-radius: 4px; color: #333;">node deepseek_javascript_20260307_5ccd66.js</code></li>' +
                    '<li>Espere o servidor iniciar e mostrar a mensagem "🚀 WEBOS SERVER RODANDO".</li>' +
                    '<li>Abra o seu navegador (Chrome, Firefox, etc).</li>' +
                    '<li>Acesse o endereço: <a href="http://localhost:8080" style="color: #007bff;">http://localhost:8080</a></li>' +
                '</ol>' +
            '</div>' +
        '</div>';
        document.body.innerHTML = html;
        return; // Para a execução do script
    }

    // Desabilita o botão de login até a conexão ser estabelecida
    const loginButton = document.getElementById('login-button');
    loginButton.disabled = true;
    loginButton.textContent = 'Conectando...';

    // Conecta ao servidor
    conectarWebSocket();
    
    // Inicializa relógio
    atualizarRelogio();
    setInterval(atualizarRelogio, 1000);
    
    // Carrega tema salvo
    const temaSalvo = localStorage.getItem('webos-theme') || 'light';
    alternarTema(temaSalvo);
    
    // Event listeners para tema
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => alternarTema(btn.dataset.theme));
    });
    
    // Login com Enter
    document.getElementById('senha').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') fazerLogin();
    });
    
    // Lista apps disponíveis
    setTimeout(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ tipo: 'listar_apps' }));
        }
    }, 1000);
});

    </script>
</body>
</html>
`;
