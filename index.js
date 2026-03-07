const { NodeSSH } = require('node-ssh');
const WebSocket = require('ws');
const http = require('http');

const ssh = new NodeSSH();
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Render Monitor</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { background: #000; color: #0f0; font-family: monospace; padding: 15px; margin: 0; }
                #status { color: yellow; font-weight: bold; }
                pre { white-space: pre-wrap; word-wrap: break-word; font-size: 13px; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div style="background: #222; padding: 10px; border-bottom: 1px solid #444;">
                Status: <span id="status">Conectando...</span>
            </div>
            <pre id="logs">Iniciando fluxo de dados...</pre>
            <script>
                const logs = document.getElementById('logs');
                const status = document.getElementById('status');
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(protocol + '//' + window.location.host);

                ws.onmessage = (e) => { 
                    if(logs.innerText.includes("Iniciando")) logs.innerText = "";
                    logs.innerText += e.data; 
                    window.scrollTo(0, document.body.scrollHeight); 
                };
                ws.onopen = () => status.innerText = "CONECTADO AO MONITOR";
                ws.onclose = () => { status.innerText = "OFFLINE"; status.style.color = "red"; };
                ws.onerror = () => status.innerText = "ERRO NA CONEXÃO";
            </script>
        </body>
        </html>
    `);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.send(">>> Tentando SSH com Render Cloud...\n");
    
    // Verificamos se a chave existe nas variáveis de ambiente
    if (!process.env.SSH_KEY) {
        ws.send("ERRO: Variável SSH_KEY não encontrada no painel do Render!\n");
        return;
    }

    ssh.connect({
        host: '://render.com',
        username: 'srv-c7...', // <--- COLOQUE SEU ID AQUI
        privateKey: process.env.SSH_KEY.replace(/\\n/g, '\n') // Corrige quebras de linha
    }).then(() => {
        ws.send(">>> SSH OK! Lendo logs em tempo real...\n");
        ssh.exec('tail -f /var/log/render/output.log', [], { 
            stream: 'stdout',
            onStdout(chunk) { ws.send(chunk.toString()); },
            onStderr(chunk) { ws.send("ERRO LOG: " + chunk.toString()); }
        });
    }).catch(err => {
        ws.send("Erro SSH: " + err.message + "\n");
    });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Rodando na porta ${PORT}`));
