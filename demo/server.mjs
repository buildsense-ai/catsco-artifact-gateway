import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { port, name } from '../src/config.mjs';
const appId = name(process.env.APP_ID || 'demo');
const gatewayBase = process.env.GATEWAY_BASE || 'https://artifact.catsco.cc';
const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });
const statePath = path.join(dataDir, 'state.json');
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { count: 0 };
function save() { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state)); fs.renameSync(`${statePath}.tmp`, statePath); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = (status, body, type='application/json') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  // Reference integration. The application forwards whatever credential the
  // caller presented (cookie or bearer) to the gateway and reads the answer; it
  // never parses a ticket and never decides identity by itself.
  if (url.pathname === '/api/whoami' && req.method === 'GET') {
    try {
      const upstream = await fetch(`${gatewayBase}/_gateway/me?app=${encodeURIComponent(appId)}`, {
        headers: { cookie: req.headers.cookie || '', authorization: req.headers.authorization || '' },
      });
      return reply(upstream.status, await upstream.json());
    } catch {
      return reply(502, { error: 'identity_unavailable' });
    }
  }
  if (url.pathname === '/health') return reply(200, { ok: true, appId, uid: process.getuid?.(), pid: process.pid });
  if (url.pathname === '/api/state' && req.method === 'GET') return reply(200, { appId, ...state });
  if (url.pathname === '/api/increment' && req.method === 'POST') {
    // Disposable P0 counter is intentionally public; no credentials or user data.
    if (Number(req.headers['content-length'] || 0) > 1024 || req.headers['transfer-encoding']) return reply(413, { error: 'body_too_large' });
    req.resume(); state = { count: state.count + 1 }; save(); return reply(200, { appId, ...state });
  }
  if (url.pathname === '/download' && req.method === 'GET') {
    res.setHeader('Content-Disposition', 'attachment; filename="demo-state.json"');
    return reply(200, { appId, ...state });
  }
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ appId, tick: 0 })}\n\n`);
    let tick = 0; const t = setInterval(() => res.write(`data: ${JSON.stringify({ appId, tick: ++tick })}\n\n`), 1000);
    req.on('close', () => clearInterval(t)); return;
  }
  if (url.pathname === '/' && req.method === 'GET') return reply(200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>轻 Artifact 验证</title><style>body{margin:0;background:#eff3ec;color:#214535;font:17px/1.7 sans-serif}main{max-width:700px;margin:70px auto;padding:30px}h1{font-size:34px}section{background:white;padding:28px;border-radius:16px;margin:20px 0}button,a{color:#214535}button{padding:12px 24px;border:0;border-radius:9px;background:#d5e8cc;cursor:pointer}strong{font-size:42px}small{display:block;color:#607465}</style><main><small>CAT SCO / 独立原型 · 非正式 Artifact</small><h1>本地应用，公网可达。</h1><p>应用：<b>${appId}</b> · 服务运行 UID：${process.getuid?.()}</p><section><small>数据保存在 Bot 本地 JSON，刷新后仍保留。</small><strong id="count">…</strong><p><button id="add">计数 +1</button>　<a href="download">下载 JSON</a></p><p id="error" role="status"></p></section><small id="stream">正在连接事件流…</small><p>本演示计数器公开可写，不含任何真实业务数据。连接器不会调用模型。</p></main><script>async function update(increment=false){try{const r=await fetch(increment?'api/increment':'api/state',{method:increment?'POST':'GET'});if(!r.ok)throw Error('请求失败 '+r.status);const s=await r.json();document.getElementById('count').textContent=s.count;document.getElementById('error').textContent=''}catch(e){document.getElementById('error').textContent=e.message}}document.getElementById('add').onclick=()=>update(true);update();const s=new EventSource('events');s.onmessage=e=>{document.getElementById('stream').textContent='实时事件流正常 · '+JSON.parse(e.data).tick};s.onerror=()=>document.getElementById('stream').textContent='事件流断开，等待恢复';</script></html>`, 'text/html; charset=utf-8');
  reply(404, { error: 'not_found' });
});
// Minimal server-to-client WebSocket probe, no arbitrary message execution.
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws' || !req.headers['sec-websocket-key']) return socket.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const payload = Buffer.from(JSON.stringify({ appId, ok: true }));
  socket.end(Buffer.concat([Buffer.from([0x81, payload.length]), payload, Buffer.from([0x88, 0])]));
});
server.listen(port(Number(process.env.PORT || 20171)), '127.0.0.1', () => console.log(JSON.stringify({ appId, uid: process.getuid?.(), port: server.address().port })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
