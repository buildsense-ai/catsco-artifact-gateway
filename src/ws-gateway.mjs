// Transport adapter only. Authentication and forward permissions remain in OpenSSH.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { tunnelMaxConnections } from './config.mjs';

// The ceiling exists because each tunnel spawns a pair of sshd processes (roughly
// 13 MB together), so an unbounded number of them would exhaust the host's memory
// long before anything else noticed. It counts every connection the process holds:
// there is no per-bot attribution on this socket — the tunnel URL carries no
// identity — so one shared pool is what the limit can be.
export function createTunnelServer({ maxConnections, sshPort = 22443 } = {}) {
  const limit = tunnelMaxConnections(maxConnections);
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url === '/health', activeConnections: wss.clients.size, maxConnections: limit }));
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 262144 });
  server.on('upgrade', (req, socket, head) => {
    // The only upstream is the dedicated loopback sshd, never a user supplied address.
    if (req.url !== '/tunnel' || req.headers.origin || wss.clients.size >= limit) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const stream = createWebSocketStream(ws, { highWaterMark: 32768 });
    const tcp = net.connect({ host: '127.0.0.1', port: Number(sshPort) });
    let alive = true;
    const pulse = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 20000);
    ws.on('pong', () => { alive = true; });
    const cleanup = () => { clearInterval(pulse); tcp.destroy(); stream.destroy(); ws.terminate(); };
    tcp.on('error', cleanup); tcp.on('close', cleanup);
    stream.on('error', cleanup); ws.on('error', cleanup); ws.on('close', cleanup);
    tcp.pipe(stream).pipe(tcp);
  });
  return { server, wss, limit };
}

// Standalone entry point used by deploy/ws-gateway.service. The guard keeps the
// module importable by tests, which start their own listener on an ephemeral port.
if (process.argv[1] && process.argv[1].endsWith('ws-gateway.mjs')) {
  const port = Number(process.env.PORT || 22444);
  const { server, wss } = createTunnelServer({
    maxConnections: process.env.TUNNEL_MAX_CONNECTIONS,
    sshPort: process.env.SSH_PORT || 22443,
  });
  server.listen(port, '127.0.0.1');
  // Terminate the tunnels before closing: `server.close` waits for open
  // connections, and a websocket that is mid-stream never ends on its own, so
  // without this the shutdown would hang until systemd killed it.
  process.on('SIGTERM', () => { for (const ws of wss.clients) ws.terminate(); server.close(); });
}
