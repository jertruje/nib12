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
            <title>Monitor Render - Vercel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { background: #000; color: #0f0; font-family: monospace; padding: 15px; }
                #status { color: yellow; }
                pre { white-space: pre-wrap; word-wrap: break-word; font-size: 12px; }
            </style>
        </head>
        <body>
            <div>Status: <span id="status">Conectando...</span></div>
            <pre id="logs"></pre>
            <script>
                const logs = document.getElementById('logs');
                const status = document.getElementById('status');
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(protocol + '//' + window.location.host);

                ws.onmessage = (e) => { logs.innerText += e.data; window.scrollTo(0, document.body.scrollHeight); };
                ws.onopen = () => status.innerText = "ONLINE (Vercel)";
                ws.onclose = () => status.innerText = "OFFLINE";
                ws.onerror = (e) => status.innerText = "ERRO: " + e;
            </script>
        </body>
        </html>
    `);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ssh.connect({
        host: '://render.com',
        username: 'srv-SEU_ID_AQUI', // <--- COLOQUE SEU ID DO RENDER AQUI
        privateKey: process.env.SSH_KEY // Usaremos Variável de Ambiente para segurança
    }).then(() => {
        ssh.exec('tail -n 50 /var/log/render/output.log', [], { // tail -n 50 para não travar no Vercel
            stream: 'stdout',
            onStdout(chunk) { ws.send(chunk.toString()); }
        });
    }).catch(err => ws.send("Erro SSH: " + err.message));
});

server.listen(PORT);
