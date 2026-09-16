// Transport adapter only. Authentication and forward permissions remain in OpenSSH.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, createWebSocketStream } from 'ws';
const server = http.createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: req.url === '/health', activeConnections: wss.clients.size }));
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 262144 });
server.on('upgrade', (req, socket, head) => {
  // The only upstream is the dedicated loopback sshd, never a user supplied address.
  if (req.url !== '/tunnel' || req.headers.origin || wss.clients.size >= 32) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', ws => {
  const stream = createWebSocketStream(ws, { highWaterMark: 32768 });
  const tcp = net.connect({ host: '127.0.0.1', port: Number(process.env.SSH_PORT || 22443) });
  let alive = true;
  const pulse = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 20000);
  ws.on('pong', () => { alive = true; });
  const cleanup = () => { clearInterval(pulse); tcp.destroy(); stream.destroy(); ws.terminate(); };
  tcp.on('error', cleanup); tcp.on('close', cleanup);
  stream.on('error', cleanup); ws.on('error', cleanup); ws.on('close', cleanup);
  tcp.pipe(stream).pipe(tcp);
});
server.listen(Number(process.env.PORT || 22444), '127.0.0.1');
process.on('SIGTERM', () => { for (const ws of wss.clients) ws.terminate(); server.close(); });
