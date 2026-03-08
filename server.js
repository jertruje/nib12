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
        this.usuarios = new Map();
        this.arquivos = new Map();
        this.apps = new Map();
        this.appRepository = new Map();
        this.sessoes = new Map();
        this.processos = new Map();
        
        this.discos = {
            ssd: new DiscoVirtual('ssd', 100 * 1024 * 1024 * 1024),
            hdd: new DiscoVirtual('hdd', 1000 * 1024 * 1024 * 1024),
            backup: new BackupVirtual()
        };
        
        this.init();
    }
    
    init() {
        this.carregarAppsPadrao();
        this.carregarRepositorioApps();
        this.carregarEstado();
        this.criarEstruturaInicial();
        
        console.log('🚀 Servidor WebOS iniciado!');
    }
    
    async carregarUsuarios() {
        try {
            const dados = await fs.readFile(path.join(__dirname, 'users.json'), 'utf8');
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
        const usuariosObj = Object.fromEntries(this.usuarios);
        await fs.writeFile(path.join(__dirname, 'users.json'), JSON.stringify(usuariosObj, null, 2));
        
        const arquivosObj = Array.from(this.arquivos.entries());
        await fs.writeFile(path.join(__dirname, 'filesystem.json'), JSON.stringify(arquivosObj, null, 2));
        
        const ssdDados = Array.from(this.discos.ssd.dados.entries());
        await fs.writeFile(path.join(__dirname, 'disk_ssd.json'), JSON.stringify(ssdDados));
    }

    async carregarEstado() {
        await this.carregarUsuarios();
        
        try {
            const fsData = await fs.readFile(path.join(__dirname, 'filesystem.json'), 'utf8');
            this.arquivos = new Map(JSON.parse(fsData));
            for (let [k, v] of this.arquivos) {
                v.criado = new Date(v.criado);
                v.modificado = new Date(v.modificado);
            }
            console.log(`📂 ${this.arquivos.size} arquivos indexados.`);
        } catch (e) { console.log('ℹ️ Novo sistema de arquivos.'); }
        
        try {
            const diskData = await fs.readFile(path.join(__dirname, 'disk_ssd.json'), 'utf8');
            const entries = JSON.parse(diskData);
            this.discos.ssd.dados = new Map(entries);
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

    async conectarUsuario(ws, dados) {
        const { usuario, senha } = dados;
        
        if (!this.usuarios.has(usuario)) {
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
        
        const token = crypto.randomBytes(16).toString('hex');
        this.sessoes.set(token, {
            usuario,
            ws,
            conectado: new Date(),
            processos: [],
            clipboard: ''
        });
        
        ws.send(JSON.stringify({
            tipo: 'login_sucesso',
            token,
            usuario: this.usuarios.get(usuario),
            area_trabalho: await this.getAreaTrabalho(usuario)
        }));
        
        return token;
    }
    
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

    async salvarArquivo(usuario, caminho, conteudo, tipo) {
        const caminhoCompleto = `/usuarios/${usuario}/${caminho}`;
        const tamanho = conteudo.length;
        let destino = 'ssd';
        
        if (tamanho > 100 * 1024 * 1024) {
            destino = 'hdd';
        }
        
        if (tipo && tipo.includes('video/') && tamanho > 500 * 1024 * 1024) {
            destino = 'hdd';
        }
        
        const hash = await this.discos[destino].salvar(caminhoCompleto, conteudo);
        
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
        
        if (tipo && (tipo.includes('document') || tipo.includes('text'))) {
            this.discos.backup.fazerBackup(caminhoCompleto, conteudo);
        }
        
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
        
        const conteudo = await this.discos[metadata.destino].ler(metadata.caminho, metadata.hash);
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
    
    carregarAppsPadrao() {
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
                        if (!this.apps.has(id)) {
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
            logica: () => ({ status: 'ok' })
        });

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

        this.apps.set('android_emulator', {
            nome: 'Android Emulator',
            versao: '1.0',
            tipo: 'emulador',
            icone: '🤖',
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
                return { status: 'ok' };
            }
        });
        
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

        this.appRepository.set('nes_emulator', {
            nome: 'Emulador NES (Wasm)',
            versao: '1.0',
            tipo: 'emulador',
            icone: '🕹️',
            ui: `<div style="width:100%; height:100%;"><iframe src="https://nes.party/?rom={romUrl}" style="width:100%; height:100%; border:none;" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>`,
            logica: () => ({ status: 'ok' })
        });

        this.appRepository.set('gba_emulator', {
            nome: 'Emulador GBA (Wasm)',
            versao: '1.0',
            tipo: 'emulador',
            icone: '👾',
            ui: `<div style="width:100%; height:100%;"><iframe src="https://gba.party/?rom={romUrl}" style="width:100%; height:100%; border:none;" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>`,
            logica: () => ({ status: 'ok' })
        });

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

        this.appRepository.set('linux', {
            nome: 'Linux Terminal',
            versao: 'Kernel 2.6',
            tipo: 'emulador',
            icone: '🐧',
            descricao: 'Ambiente Linux completo rodando via WebAssembly (v86).',
            ui: `<iframe src="https://copy.sh/v86/?profile=linux26" style="width:100%; height:100%; border:none;"></iframe>`,
            logica: () => ({ status: 'ok' })
        });

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
            if (caminho.endsWith('/')) caminho = caminho.slice(0, -1);
            
            const todosArquivos = await this.listarArquivos(usuario, caminho);
            const itens = [];
            
            for (const arq of todosArquivos) {
                let rel = arq.caminho_relativo;
                
                if (caminho) {
                    if (!rel.startsWith(caminho + '/')) continue;
                    rel = rel.substring(caminho.length + 1);
                }
                
                const partes = rel.split('/');
                
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
                return this.fileManagerLogic('listar', { caminho: args.caminho }, usuario);
            }
            
            const todosArquivos = await this.listarArquivos(usuario, ''); 
            const itens = todosArquivos
                .filter(arq => arq.nome.toLowerCase().includes(termo))
                .map(arq => ({
                    nome: arq.nome,
                    tipo: arq.tipo,
                    caminho: arq.caminho_relativo,
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
        const token = 'tok_lbdrpyxhox4eivc5roarla2vqq';

        if (comando === 'buscar') {
            const termo = args.termo;
            return new Promise(resolve => {
                const url = `https://archive.org/advancedsearch.php?q=collection:(apkarchive) AND title:(${encodeURIComponent(termo)})&fl[]=identifier,title&rows=10&output=json`;
                https.get(url, { headers: { 'User-Agent': 'WebOS-Server/1.0' } }, res => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            const docs = (json.response.docs || []).map(doc => ({
                                title: doc.title,
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
                                const romFile = `${doc.title.replace(/ \([^)]*\)/g, '')}.${system === 'gba' ? 'gba' : system === 'gbc' ? 'gbc' : system === 'nes' ? 'nes' : 'sfc'}`;
                                const romUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(romFile)}`;
                                return { title: doc.title, romUrl, system };
                            });
                            resolve(docs);
                        } catch (e) {
                            resolve([]);
                        }
                    });
                }).on('error', () => resolve([]));
            });
        });

        const results = await Promise.all(searchPromises);
        const allGames = results.flat();

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

    async climaLogic(comando, args) {
        if (comando === 'buscar') {
            const cidade = args.cidade;
            return new Promise(resolve => {
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

    taskManagerLogic(comando, args, usuario) {
        if (comando === 'listar') {
            const lista = [];
            for (const [pid, proc] of this.processos) {
                if (proc.usuario === usuario) {
                    const app = this.apps.get(proc.app);
                    lista.push({
                        pid: pid,
                        nome: app ? app.nome : proc.app,
                        cpu: Math.floor(Math.random() * 15) + '%',
                        memoria: Math.floor(Math.random() * 200) + 50 + ' MB'
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
                if (!isNaN(acao)) {
                    const novoDisplay = estado.display === '0' ? acao : estado.display + acao;
                    return { ...estado, display: novoDisplay };
                }
                return estado;
        }
    }
    
    blocoNotasLogic(comando, args, usuario) {
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
    
    async abrirApp(usuario, appNome, params = {}) {
        const app = this.apps.get(appNome);
        
        if (!app) {
            throw new Error('App não encontrado');
        }
        
        const processoId = crypto.randomBytes(8).toString('hex');
        const processo = {
            id: processoId,
            app: appNome,
            usuario,
            iniciado: new Date(),
            estado: {}
        };
        
        this.processos.set(processoId, processo);
        
        for (let [token, sessao] of this.sessoes) {
            if (sessao.usuario === usuario) {
                sessao.processos.push(processoId);
                break;
            }
        }
        
        let ui = app.ui;
        
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
            params
        };
    }
    
    async executarComandoApp(usuario, processoId, comando, args) {
        const processo = this.processos.get(processoId);
        
        if (!processo) {
            throw new Error('Processo não encontrado');
        }
        
        const app = this.apps.get(processo.app);
        
        let resultado = app.logica(comando, args, usuario);
        
        if (resultado && resultado.then) {
            resultado = await resultado;
        }
        
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
    
    criarPastaUsuario(usuario) {
        const pastas = ['Documentos', 'Fotos', 'Videos', 'Downloads', 'Desktop'];
        
        pastas.forEach(pasta => {
            const caminho = `/usuarios/${usuario}/${pasta}`;
            
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
        this.arquivos.set('/usuarios', {
            nome: 'usuarios',
            caminho: '/usuarios',
            tipo: 'directory'
        });
        
        this.arquivos.set('/sistema/config.json', {
            nome: 'config.json',
            caminho: '/sistema/config.json',
            tipo: 'application/json',
            tamanho: 1024,
            destino: 'ssd'
        });
    }
    
    async getAreaTrabalho(usuario) {
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
        
        if (this.backups.get(caminho).length > 5) {
            this.backups.get(caminho).shift();
        }
        
        console.log(`💾 Backup realizado: ${caminho}`);
    }
}

const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') {
        res.writeHead(204, { 'Content-Type': 'image/x-icon' });
        res.end();
        return;
    }

    console.log(`\n➡️  [${new Date().toLocaleTimeString()}] Requisição HTTP: ${req.method} ${req.url}`);
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

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════╗
    ║     🚀 WEBOS SERVER RODANDO          ║
    ║    📡 Acesso: http://localhost:${PORT}   ║
    ║    💾 Discos: SSD (100GB) + HDD (1TB)║
    ║    👥 Usuários: Ilimitado            ║
    ║    📱 Apps: +20 aplicativos          ║
    ╚══════════════════════════════════════╝
    `);
    console.log('📌 Abra o endereço acima no seu navegador para usar o WebOS.');
});

const clienteHTML = `<!DOCTYPE html>
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
    const porta = window.location.port || '8080';
    
    try {
        socket = new WebSocket(protocolo + '//' + host + ':' + porta);
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
      `;