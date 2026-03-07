const { NodeSSH } = require('node-ssh');
const WebSocket = require('ws');
const http = require('http');

const ssh = new NodeSSH();
const PORT = process.env.PORT || 8080;

// 1. Criar Servidor HTTP para entregar o HTML
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Monitor Render</title>
            <style>
                body { background: #000; color: #0f0; font-family: monospace; padding: 20px; }
                #logs { white-space: pre-wrap; word-wrap: break-word; }
                .meta { color: #888; border-bottom: 1px solid #333; margin-bottom: 10px; }
            </style>
        </head>
        <body>
            <div class="meta">Chave: shk-d6m41alaae7s73fb8ijg | Status: <span id="status">Conectando...</span></div>
            <div id="logs"></div>
            <script>
                const logsDiv = document.getElementById('logs');
                const status = document.getElementById('status');
                const ws = new WebSocket('ws://' + window.location.host);

                ws.onmessage = (e) => {
                    logsDiv.innerText += e.data;
                    window.scrollTo(0, document.body.scrollHeight);
                };
                ws.onopen = () => status.innerText = "ONLINE";
                ws.onclose = () => status.innerText = "OFFLINE";
            </script>
        </body>
        </html>
    `);
});

// 2. Criar WebSocket atrelado ao servidor HTTP
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ssh.connect({
        host: '://render.com',
        username: 'srv-SEU_ID_AQUI', // Substitua pelo ID do seu serviço no Render
        privateKeyPath: './id_rsa'    // Sua chave privada deve estar na mesma pasta
    }).then(() => {
        ssh.exec('tail -f /var/log/render/output.log', [], {
            stream: 'stdout',
            onStdout(chunk) { ws.send(chunk.toString()); }
        });
    }).catch(err => ws.send("Erro SSH: " + err.message));
});

server.listen(PORT, () => {
    console.log(`Acesse no navegador: http://localhost:${PORT}`);
});
