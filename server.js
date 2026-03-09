junte com as funções desse código <!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Linux WebAssembly OS - Instale Apps Linux REAIS</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Courier New', monospace;
        }

        body {
            background: #1a1e24;
            color: #00ff9d;
            height: 100vh;
            overflow: hidden;
        }

        /* Container Principal */
        .linux-os {
            display: grid;
            grid-template-columns: 280px 1fr;
            grid-template-rows: 50px 1fr;
            height: 100vh;
            background: #0f1419;
        }

        /* Barra Superior */
        .top-bar {
            grid-column: 1 / -1;
            background: #1e2a3a;
            border-bottom: 2px solid #00ff9d;
            display: flex;
            align-items: center;
            padding: 0 20px;
            gap: 20px;
            color: #00ff9d;
        }

        .linux-logo {
            font-size: 1.3rem;
            font-weight: bold;
            text-shadow: 0 0 10px #00ff9d;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .kernel-version {
            background: #2a3a4a;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
        }

        .system-stats {
            margin-left: auto;
            display: flex;
            gap: 20px;
            font-size: 0.9rem;
        }

        .stat {
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .cpu-led {
            width: 10px;
            height: 10px;
            background: #00ff9d;
            border-radius: 50%;
            animation: blink 1s infinite;
        }

        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }

        /* Sidebar - Pacotes Instalados */
        .sidebar {
            background: #1a2632;
            border-right: 1px solid #2a3a4a;
            padding: 20px;
            overflow-y: auto;
        }

        .section-title {
            color: #00ff9d;
            font-size: 1rem;
            text-transform: uppercase;
            letter-spacing: 2px;
            margin: 20px 0 15px 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .section-title:first-child {
            margin-top: 0;
        }

        .package-list {
            list-style: none;
        }

        .package-item {
            background: #1e2f3d;
            border-left: 3px solid #00ff9d;
            margin-bottom: 8px;
            padding: 12px;
            border-radius: 0 8px 8px 0;
            cursor: pointer;
            transition: all 0.2s;
        }

        .package-item:hover {
            background: #2a4052;
            transform: translateX(5px);
        }

        .package-name {
            font-weight: bold;
            color: #fff;
            display: flex;
            justify-content: space-between;
        }

        .package-version {
            font-size: 0.7rem;
            color: #00ff9d;
        }

        .package-desc {
            font-size: 0.8rem;
            color: #8a9aa8;
            margin-top: 4px;
        }

        .package-size {
            font-size: 0.7rem;
            color: #5a7a8a;
            margin-top: 4px;
        }

        /* Área Principal */
        .main-area {
            padding: 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        /* Terminal Principal */
        .terminal {
            background: #0c1218;
            border: 1px solid #2a3a4a;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 0 20px rgba(0, 255, 157, 0.1);
        }

        .terminal-header {
            background: #1a2632;
            padding: 10px 15px;
            border-bottom: 1px solid #2a3a4a;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .terminal-title {
            display: flex;
            align-items: center;
            gap: 8px;
            color: #00ff9d;
        }

        .terminal-buttons {
            display: flex;
            gap: 10px;
        }

        .term-btn {
            background: #2a3a4a;
            border: none;
            color: #8a9aa8;
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.8rem;
        }

        .term-btn:hover {
            background: #3a5068;
            color: #fff;
        }

        #xterm-container {
            height: 400px;
            padding: 10px;
            background: #0c1218;
        }

        /* Loja de Apps */
        .app-store {
            background: #1a2632;
            border: 1px solid #2a3a4a;
            border-radius: 8px;
            overflow: hidden;
        }

        .store-header {
            background: #1e2f3d;
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .store-header h3 {
            color: #00ff9d;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .store-search {
            background: #0f1a24;
            border: 1px solid #2a3a4a;
            color: #00ff9d;
            padding: 8px 16px;
            border-radius: 20px;
            width: 300px;
            outline: none;
        }

        .store-search::placeholder {
            color: #3a5068;
        }

        .apps-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
            padding: 20px;
        }

        .store-app {
            background: #1e2f3d;
            border: 1px solid #2a3a4a;
            border-radius: 8px;
            padding: 15px;
            transition: all 0.2s;
        }

        .store-app:hover {
            border-color: #00ff9d;
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(0, 255, 157, 0.2);
        }

        .app-icon {
            font-size: 2rem;
            margin-bottom: 10px;
        }

        .app-title {
            font-weight: bold;
            color: #fff;
            font-size: 1.1rem;
        }

        .app-repo {
            font-size: 0.7rem;
            color: #00ff9d;
            margin: 5px 0;
        }

        .app-description {
            font-size: 0.85rem;
            color: #8a9aa8;
            margin: 10px 0;
            line-height: 1.4;
        }

        .app-meta {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 15px;
            font-size: 0.8rem;
            color: #5a7a8a;
        }

        .install-btn {
            background: #00ff9d;
            border: none;
            color: #0f1419;
            padding: 6px 16px;
            border-radius: 20px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 0.9rem;
        }

        .install-btn:hover {
            background: #00cc7d;
            transform: scale(1.05);
        }

        .install-btn.installed {
            background: #2a4052;
            color: #8a9aa8;
            cursor: default;
        }

        /* Modal do App */
        .app-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.95);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }

        .app-modal.active {
            display: flex;
        }

        .modal-content {
            width: 90%;
            height: 90%;
            background: #1a2632;
            border: 2px solid #00ff9d;
            border-radius: 8px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .modal-header {
            background: #1e2f3d;
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #2a3a4a;
        }

        .modal-header h2 {
            color: #00ff9d;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .close-btn {
            background: none;
            border: none;
            color: #fff;
            font-size: 1.5rem;
            cursor: pointer;
            width: 35px;
            height: 35px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .close-btn:hover {
            background: #ff4444;
        }

        .modal-body {
            flex: 1;
            background: #0c1218;
            overflow: hidden;
        }

        #app-terminal {
            width: 100%;
            height: 100%;
            background: #0c1218;
            color: #00ff9d;
            font-family: 'Courier New', monospace;
            padding: 20px;
            overflow-y: auto;
            white-space: pre-wrap;
        }

        .terminal-line {
            margin: 2px 0;
            color: #00ff9d;
        }

        .terminal-input {
            display: flex;
            margin-top: 10px;
        }

        .terminal-prompt {
            color: #00ff9d;
            margin-right: 10px;
        }

        .terminal-input-field {
            background: none;
            border: none;
            color: #00ff9d;
            font-family: 'Courier New', monospace;
            font-size: 1rem;
            flex: 1;
            outline: none;
        }
    </style>
    
    <!-- xterm.js para terminal real -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css" />
    <script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
    
    <!-- jslinux para emulação real -->
    <script src="https://bellard.org/jslinux/virtio.js"></script>
    <script src="https://bellard.org/jslinux/utils.js"></script>
</head>
<body>
    <div class="linux-os">
        <!-- Top Bar -->
        <div class="top-bar">
            <div class="linux-logo">
                <span>🐧</span>
                <span>WebLinux v5.4 (WASM)</span>
            </div>
            <div class="kernel-version">Kernel 5.4.0-wasm</div>
            <div class="system-stats">
                <div class="stat">
                    <span class="cpu-led"></span>
                    <span id="cpu-usage">CPU: 2%</span>
                </div>
                <div class="stat">
                    <span>📊</span>
                    <span id="memory-stats">RAM: 64MB/256MB</span>
                </div>
                <div class="stat">
                    <span>📦</span>
                    <span id="packages-count">Pacotes: 12</span>
                </div>
            </div>
        </div>

        <!-- Sidebar - Pacotes Instalados -->
        <div class="sidebar">
            <div class="section-title">
                <span>📦</span> Pacotes Instalados
            </div>
            <ul class="package-list" id="installed-packages">
                <!-- Será preenchido via JS -->
            </ul>

            <div class="section-title">
                <span>⚙️</span> Serviços
            </div>
            <ul class="package-list">
                <li class="package-item" onclick="runCommand('systemctl status sshd')">
                    <div class="package-name">sshd <span class="package-version">running</span></div>
                    <div class="package-desc">OpenSSH Server</div>
                </li>
                <li class="package-item" onclick="runCommand('systemctl status apache2')">
                    <div class="package-name">apache2 <span class="package-version">running</span></div>
                    <div class="package-desc">Web Server</div>
                </li>
                <li class="package-item" onclick="runCommand('systemctl status docker')">
                    <div class="package-name">docker <span class="package-version">stopped</span></div>
                    <div class="package-desc">Container Runtime</div>
                </li>
            </ul>
        </div>

        <!-- Área Principal -->
        <div class="main-area">
            <!-- Terminal Linux REAL -->
            <div class="terminal">
                <div class="terminal-header">
                    <div class="terminal-title">
                        <span>🐚</span>
                        <span>Terminal Linux - bash 5.1</span>
                    </div>
                    <div class="terminal-buttons">
                        <button class="term-btn" onclick="clearTerminal()">Limpar</button>
                        <button class="term-btn" onclick="runCommand('ls -la')">ls</button>
                        <button class="term-btn" onclick="runCommand('ps aux')">ps</button>
                        <button class="term-btn" onclick="runCommand('df -h')">df</button>
                    </div>
                </div>
                <div id="xterm-container"></div>
            </div>

            <!-- Loja de Apps Linux -->
            <div class="app-store">
                <div class="store-header">
                    <h3>
                        <span>📥</span> Instalar Aplicativos Linux
                    </h3>
                    <input type="text" class="store-search" placeholder="Buscar pacotes apt..." id="package-search">
                </div>
                <div class="apps-grid" id="apps-grid">
                    <!-- Apps serão inseridos aqui -->
                </div>
            </div>
        </div>
    </div>

    <!-- Modal para executar apps -->
    <div class="app-modal" id="appModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 id="modalAppName">
                    <span>🐧</span>
                    <span>Executando: </span>
                </h2>
                <button class="close-btn" onclick="closeAppModal()">✕</button>
            </div>
            <div class="modal-body">
                <div id="app-terminal"></div>
            </div>
        </div>
    </div>

    <script>
        // Linux Runtime REAL usando JSLinux
        class LinuxRuntime {
            constructor() {
                this.term = null;
                this.vm = null;
                this.fs = null;
                this.packages = new Map();
                this.installedPackages = [];
                
                // Pacotes disponíveis (simulando apt repo)
                this.availablePackages = [
                    {
                        name: 'gcc',
                        version: '9.3.0',
                        size: '45 MB',
                        description: 'GNU C Compiler',
                        deps: 'binutils, libc6',
                        repo: 'main',
                        icon: '⚙️',
                        command: 'gcc --version'
                    },
                    {
                        name: 'python3',
                        version: '3.9.2',
                        size: '28 MB',
                        description: 'Python 3 interpreter',
                        deps: 'libpython3.9',
                        repo: 'main',
                        icon: '🐍',
                        command: 'python3 --version'
                    },
                    {
                        name: 'nodejs',
                        version: '14.17.0',
                        size: '32 MB',
                        description: 'Node.js JavaScript runtime',
                        deps: 'libnode72',
                        repo: 'universe',
                        icon: '🟢',
                        command: 'node --version'
                    },
                    {
                        name: 'git',
                        version: '2.30.2',
                        size: '18 MB',
                        description: 'Version control system',
                        deps: 'libcurl4, zlib1g',
                        repo: 'main',
                        icon: '📦',
                        command: 'git --version'
                    },
                    {
                        name: 'vim',
                        version: '8.2',
                        size: '12 MB',
                        description: 'Text editor',
                        deps: 'libncurses6',
                        repo: 'main',
                        icon: '📝',
                        command: 'vim --version'
                    },
                    {
                        name: 'htop',
                        version: '3.0.5',
                        size: '1.2 MB',
                        description: 'Interactive process viewer',
                        deps: 'libncurses6',
                        repo: 'main',
                        icon: '📊',
                        command: 'htop'
                    },
                    {
                        name: 'nginx',
                        version: '1.18.0',
                        size: '1.5 MB',
                        description: 'Web server',
                        deps: 'libpcre3, zlib1g',
                        repo: 'main',
                        icon: '🌐',
                        command: 'nginx -v'
                    },
                    {
                        name: 'mysql-server',
                        version: '8.0.25',
                        size: '158 MB',
                        description: 'MySQL database server',
                        deps: 'libaio1, libncurses6',
                        repo: 'main',
                        icon: '🐬',
                        command: 'mysql --version'
                    },
                    {
                        name: 'docker.io',
                        version: '20.10.7',
                        size: '89 MB',
                        description: 'Container runtime',
                        deps: 'containerd, runc',
                        repo: 'docker',
                        icon: '🐳',
                        command: 'docker --version'
                    },
                    {
                        name: 'redis-server',
                        version: '6.2.4',
                        size: '6.5 MB',
                        description: 'In-memory database',
                        deps: 'libjemalloc2',
                        repo: 'main',
                        icon: '⚡',
                        command: 'redis-server --version'
                    },
                    {
                        name: 'postgresql',
                        version: '13.3',
                        size: '124 MB',
                        description: 'PostgreSQL database',
                        deps: 'libpq5',
                        repo: 'main',
                        icon: '🐘',
                        command: 'postgres --version'
                    },
                    {
                        name: 'ffmpeg',
                        version: '4.4',
                        size: '78 MB',
                        description: 'Multimedia framework',
                        deps: 'libavcodec58, libavformat58',
                        repo: 'universe',
                        icon: '🎬',
                        command: 'ffmpeg -version'
                    },
                    {
                        name: 'imagemagick',
                        version: '6.9.11',
                        size: '4.2 MB',
                        description: 'Image manipulation tools',
                        deps: 'libmagickcore6',
                        repo: 'main',
                        icon: '🖼️',
                        command: 'convert --version'
                    },
                    {
                        name: 'curl',
                        version: '7.74.0',
                        size: '0.8 MB',
                        description: 'Command line URL tool',
                        deps: 'libcurl4',
                        repo: 'main',
                        icon: '🌐',
                        command: 'curl --version'
                    },
                    {
                        name: 'wget',
                        version: '1.21',
                        size: '1.1 MB',
                        description: 'Network downloader',
                        deps: 'libssl1.1',
                        repo: 'main',
                        icon: '⬇️',
                        command: 'wget --version'
                    },
                    {
                        name: 'tmux',
                        version: '3.2a',
                        size: '1.8 MB',
                        description: 'Terminal multiplexer',
                        deps: 'libevent2',
                        repo: 'main',
                        icon: '🖥️',
                        command: 'tmux -V'
                    }
                ];
            }

            async init() {
                // Inicializa terminal xterm.js
                this.term = new Terminal({
                    cursorBlink: true,
                    theme: {
                        background: '#0c1218',
                        foreground: '#00ff9d',
                        cursor: '#00ff9d'
                    },
                    fontFamily: '"Courier New", monospace',
                    fontSize: 14
                });
                
                this.term.open(document.getElementById('xterm-container'));
                
                // Escreve mensagem de boot
                this.writeln('🐧 Inicializando Linux Kernel via WebAssembly...');
                await this.sleep(500);
                this.writeln('[    0.000] Linux version 5.4.0-wasm (build@webassembly) (gcc version 9.3.0) #1 SMP WebAssembly');
                await this.sleep(300);
                this.writeln('[    0.325] CPU: WebAssembly Virtual CPU (2 cores)');
                await this.sleep(200);
                this.writeln('[    0.642] Memory: 256MB available');
                await this.sleep(300);
                this.writeln('[    1.154] Mounting root filesystem...');
                await this.sleep(400);
                this.writeln('[    1.453] Starting systemd...');
                await this.sleep(500);
                this.writeln('✅ Linux iniciado com sucesso via WebAssembly!');
                this.writeln('');
                
                // Cria sistema de arquivos virtual
                this.fs = {
                    '/': { type: 'dir' },
                    '/bin': { type: 'dir' },
                    '/usr': { type: 'dir' },
                    '/usr/bin': { type: 'dir' },
                    '/etc': { type: 'dir' },
                    '/home': { type: 'dir' },
                    '/home/user': { type: 'dir' }
                };
                
                // Prompt
                this.term.write('\r\n$ ');
                
                // Handler de comandos
                this.term.onKey(e => this.handleKey(e));
                
                // Carrega pacotes iniciais
                this.installedPackages = [
                    { name: 'bash', version: '5.1', size: '2.1 MB' },
                    { name: 'coreutils', version: '8.32', size: '15 MB' },
                    { name: 'systemd', version: '247', size: '22 MB' }
                ];
                
                this.updateUI();
            }

            handleKey(e) {
                const key = e.key;
                
                if(key === '\r') { // Enter
                    this.writeln('');
                    this.executeCommand(this.currentLine);
                    this.currentLine = '';
                    this.term.write('$ ');
                } else if(key === '\x7f') { // Backspace
                    if(this.currentLine.length > 0) {
                        this.currentLine = this.currentLine.slice(0, -1);
                        this.term.write('\b \b');
                    }
                } else {
                    this.currentLine += key;
                    this.term.write(key);
                }
            }

            async executeCommand(cmd) {
                if(!cmd.trim()) return;
                
                const args = cmd.trim().split(' ');
                const command = args[0];
                
                switch(command) {
                    case 'ls':
                        this.writeln('bin   dev   home  lib64  mnt   proc  run   srv   tmp   var');
                        this.writeln('boot  etc   lib   media  opt   root  sbin  sys   usr');
                        break;
                        
                    case 'pwd':
                        this.writeln('/home/user');
                        break;
                        
                    case 'whoami':
                        this.writeln('user');
                        break;
                        
                    case 'apt':
                        if(args[1] === 'install') {
                            const pkg = args[2];
                            this.installPackage(pkg);
                        } else if(args[1] === 'list') {
                            this.writeln('Listando pacotes disponíveis...');
                            this.availablePackages.slice(0, 5).forEach(p => {
                                this.writeln(`${p.name} - ${p.version} [${p.repo}]`);
                            });
                        } else {
                            this.writeln('apt 2.2.4 (amd64)');
                            this.writeln('Comandos: install, remove, update, upgrade, list');
                        }
                        break;
                        
                    case 'gcc':
                        this.writeln('gcc (Ubuntu 9.3.0-17ubuntu1) 9.3.0');
                        break;
                        
                    case 'python3':
                        this.writeln('Python 3.9.2');
                        break;
                        
                    case 'git':
                        this.writeln('git version 2.30.2');
                        break;
                        
                    case 'clear':
                        this.term.clear();
                        break;
                        
                    case 'help':
                        this.writeln('Comandos disponíveis:');
                        this.writeln('  ls, pwd, whoami, apt, gcc, python3, git, clear, help, ps, df, free');
                        break;
                        
                    case 'ps':
                        this.writeln('  PID TTY          TIME CMD');
                        this.writeln('    1 ?        00:00:02 systemd');
                        this.writeln('   23 ?        00:00:00 bash');
                        this.writeln('   42 ?        00:00:00 ps');
                        break;
                        
                    case 'df':
                        this.writeln('Filesystem     1K-blocks    Used Available Use% Mounted on');
                        this.writeln('/dev/vda1        256000   32456    223544  13% /');
                        break;
                        
                    case 'free':
                        this.writeln('              total        used        free      shared  buff/cache');
                        this.writeln('Mem:         262144       34567      187654        1234       39923');
                        break;
                        
                    default:
                        this.writeln(`bash: ${command}: comando não encontrado`);
                }
            }

            installPackage(pkgName) {
                const pkg = this.availablePackages.find(p => p.name === pkgName);
                
                if(pkg) {
                    if(this.installedPackages.find(p => p.name === pkgName)) {
                        this.writeln(`📦 ${pkgName} já está instalado`);
                    } else {
                        this.writeln(`📦 Instalando ${pkgName} (${pkg.version})...`);
                        this.writeln(`   Tamanho: ${pkg.size}`);
                        this.writeln(`   Dependências: ${pkg.deps}`);
                        
                        // Simula instalação
                        setTimeout(() => {
                            this.installedPackages.push(pkg);
                            this.writeln(`✅ ${pkgName} instalado com sucesso!`);
                            this.updateUI();
                            
                            // Adiciona ao sidebar
                            this.addToSidebar(pkg);
                        }, 2000);
                    }
                } else {
                    this.writeln(`❌ Pacote ${pkgName} não encontrado`);
                }
            }

            addToSidebar(pkg) {
                const list = document.getElementById('installed-packages');
                const item = document.createElement('li');
                item.className = 'package-item';
                item.onclick = () => this.runInstalledApp(pkg);
                item.innerHTML = `
                    <div class="package-name">
                        ${pkg.name}
                        <span class="package-version">${pkg.version}</span>
                    </div>
                    <div class="package-desc">${pkg.description}</div>
                    <div class="package-size">${pkg.size}</div>
                `;
                list.appendChild(item);
            }

            runInstalledApp(pkg) {
                const modal = document.getElementById('appModal');
                const modalName = document.getElementById('modalAppName');
                const terminal = document.getElementById('app-terminal');
                
                modalName.innerHTML = `<span>${pkg.icon || '🐧'}</span><span>${pkg.name} ${pkg.version}</span>`;
                modal.classList.add('active');
                
                terminal.innerHTML = `
                    <div class="terminal-line">🚀 Iniciando ${pkg.name}...</div>
                    <div class="terminal-line">Carregando WebAssembly...</div>
                    <div class="terminal-line">✅ Pronto!</div>
                    <div class="terminal-line">$ ${pkg.command}</div>
                `;
                
                // Executa comando
                setTimeout(() => {
                    this.executeInModal(pkg);
                }, 500);
            }

            executeInModal(pkg) {
                const terminal = document.getElementById('app-terminal');
                
                if(pkg.name === 'python3') {
                    terminal.innerHTML += `
                        <div class="terminal-line">Python 3.9.2 (default, Feb 28 2021, 17:03:44)</div>
                        <div class="terminal-line">[GCC 9.3.0] on linux</div>
                        <div class="terminal-line">Type "help", "copyright", "credits" or "license" for more information.</div>
                        <div class="terminal-line">>>> </div>
                    `;
                } else if(pkg.name === 'gcc') {
                    terminal.innerHTML += `
                        <div class="terminal-line">gcc (Ubuntu 9.3.0-17ubuntu1) 9.3.0</div>
                        <div class="terminal-line">Copyright (C) 2019 Free Software Foundation, Inc.</div>
                        <div class="terminal-line">This is free software; see the source for copying conditions.  There is NO</div>
                        <div class="terminal-line">warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.</div>
                    `;
                } else if(pkg.name === 'htop') {
                    terminal.innerHTML += `
                        <div class="terminal-line">📊 htop - process viewer</div>
                        <div class="terminal-line">  PID USER      PRI  NI  VIRT   RES   SHR S CPU% MEM%   TIME+  Command</div>
                        <div class="terminal-line">    1 root       20   0  168M  12M  8.4M S  0.0  4.7  0:02.3 systemd</div>
                        <div class="terminal-line">  123 user       20   0  124M  24M  6.2M S  2.3  9.4  0:00.8 bash</div>
                        <div class="terminal-line">  456 user       20   0  256M  45M  12M S  1.2 17.6  0:01.2 htop</div>
                    `;
                } else {
                    terminal.innerHTML += `
                        <div class="terminal-line">${pkg.name} versão ${pkg.version} executando via WebAssembly</div>
                        <div class="terminal-line">Uso: digite '${pkg.name} --help' para ajuda</div>
                    `;
                }
            }

            writeln(text) {
                this.term.writeln(text);
            }

            sleep(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            updateUI() {
                document.getElementById('packages-count').textContent = 
                    `Pacotes: ${this.installedPackages.length}`;
                
                // Atualiza stats
                setInterval(() => {
                    const cpu = Math.floor(Math.random() * 10) + 1;
                    document.getElementById('cpu-usage').textContent = `CPU: ${cpu}%`;
                }, 2000);
            }
        }

        // Inicialização
        const linux = new LinuxRuntime();
        
        window.onload = () => {
            linux.init();
            renderAppStore();
        };

        // Renderiza loja de apps
        function renderAppStore() {
            const grid = document.getElementById('apps-grid');
            
            linux.availablePackages.forEach(pkg => {
                const card = document.createElement('div');
                card.className = 'store-app';
                card.innerHTML = `
                    <div class="app-icon">${pkg.icon}</div>
                    <div class="app-title">${pkg.name}</div>
                    <div class="app-repo">${pkg.repo} • ${pkg.version}</div>
                    <div class="app-description">${pkg.description}</div>
                    <div class="app-meta">
                        <span>📦 ${pkg.size}</span>
                        <button class="install-btn" onclick="installPackage('${pkg.name}')">Instalar</button>
                    </div>
                `;
                grid.appendChild(card);
            });
        }

        function installPackage(name) {
            linux.installPackage(name);
        }

        function runCommand(cmd) {
            linux.executeCommand(cmd);
        }

        function clearTerminal() {
            linux.term.clear();
            linux.term.write('$ ');
        }

        function closeAppModal() {
            document.getElementById('appModal').classList.remove('active');
        }

        // Filtro de busca
        document.getElementById('package-search').addEventListener('input', (e) => {
            const search = e.target.value.toLowerCase();
            const cards = document.querySelectorAll('.store-app');
            
            cards.forEach(card => {
                const title = card.querySelector('.app-title').textContent.toLowerCase();
                const desc = card.querySelector('.app-description').textContent.toLowerCase();
                
                if(title.includes(search) || desc.includes(search)) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
        });
    </script>
</body>
</html>
