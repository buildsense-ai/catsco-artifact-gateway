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

// The page is built as a plain string so nothing in it is interpolated twice.
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>轻 Artifact 验证</title><style>
body{margin:0;background:#eff3ec;color:#214535;font:17px/1.7 sans-serif}
main{max-width:700px;margin:56px auto;padding:30px}
h1{font-size:32px;margin:8px 0 14px}
section{background:white;padding:26px;border-radius:16px;margin:18px 0}
button{padding:11px 22px;border:0;border-radius:9px;background:#d5e8cc;cursor:pointer;font-size:16px}
a{color:#214535}
strong{font-size:42px}
small{display:block;color:#607465}
.identity{border:2px solid #b9d4ae}
.identity strong{font-size:22px}
.identity p{margin:8px 0;color:#3c5a4b;word-break:break-all}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#d5e8cc;font-size:13px;color:#214535;margin-left:6px}
.badge.guest{background:#f0e0c8}
</style><main>
<small>CAT SCO / 独立原型 · 非正式 Artifact</small>
<h1>本地应用，公网可达。</h1>
<p>应用：<b>${appId}</b> · 服务运行 UID：${process.getuid?.()}</p>

<section class="identity" id="identity-card">
  <small>打开者身份（应用后端转发凭据后，向网关 <code>/_gateway/me</code> 查询所得）</small>
  <strong id="identity-state">检测中…</strong>
  <p id="identity-detail"></p>
  <p>
    <button id="identity-refresh">重新获取身份</button>
    <button id="identity-confirm" hidden>获取我的身份</button>
    <a id="identity-guest" hidden href="?identity=guest">以访客身份继续</a>
  </p>
</section>

<section><small>数据保存在 Bot 本地 JSON，刷新后仍保留。</small><strong id="count">…</strong>
<p><button id="add">计数 +1</button>　<a href="download">下载 JSON</a></p><p id="error" role="status"></p></section>
<small id="stream">正在连接事件流…</small>
<p>本演示计数器公开可写，不含任何真实业务数据。连接器不会调用模型。</p>
</main><script>
var APP_ID = ${JSON.stringify(appId)};
var framed = window.top !== window;
function el(id){ return document.getElementById(id); }
function setIdentity(state, detail){ el('identity-state').textContent = state; el('identity-detail').textContent = detail || ''; }
function show(id, on){ el(id).hidden = !on; }
function startHandshake(){ location.replace('/_auth/start?app=' + encodeURIComponent(APP_ID) + '&next=' + encodeURIComponent(location.pathname)); }
async function loadIdentity(){
  setIdentity('检测中…', '正在查询网关 /_gateway/me');
  try {
    // Relative on purpose: the application is served under /<app-id>/, so an
    // absolute '/api/...' would leave the application and hit the gateway root.
    var res = await fetch('api/whoami', { cache: 'no-store' });
    // A gateway fault answers with JSON as well, so an error body must not be
    // read as "no credentials": that would tell a signed-in visitor they are a
    // guest, which is both wrong and the opposite of reassuring.
    if (!res.ok) throw new Error('身份服务返回 ' + res.status);
    var me = await res.json();
    if (!me || me.error) throw new Error(String((me && me.error) || '身份服务返回空内容'));
    if (me.authenticated) {
      setIdentity('已确认身份' + (framed ? '（侧栏内）' : ''), '');
      // The account name and uid are what an application anchors its own rows
      // to; the pseudonym is only its local key. Either can be absent — an old
      // platform cookie carries no name, and a non-numeric subject publishes no
      // uid — so both are printed as "未知" rather than dropped.
      var account = (me.viewer.username ? me.viewer.username : '未知账号')
        + '（uid ' + (me.viewer.uid === null || me.viewer.uid === undefined ? '未知' : me.viewer.uid) + '）';
      el('identity-detail').textContent = '账号 ' + account + ' · 本应用内标识 ' + me.viewer.id + '（' + me.viewer.kind + '） · 应用 ' + me.app_id
        + (me.topic_id ? ' · 来自会话 ' + me.topic_id : ' · 无会话（直接打开网址）')
        + ' · 有效期至 ' + me.expires_at;
      show('identity-guest', false); show('identity-confirm', false); return;
    }
    if (new URLSearchParams(location.search).get('identity') === 'guest') {
      setIdentity('访客（你选择了以访客继续）', '需要身份时点「获取我的身份」');
      show('identity-guest', false); show('identity-confirm', true); return;
    }
    // No credential and no explicit choice. Stay on this page: identity is
    // optional, so leaving the page is the visitor's decision, not ours.
    setIdentity('访客（未检测到身份）', '已停在本页，不跳转。需要身份就点「获取我的身份」。');
    show('identity-guest', true); show('identity-confirm', true);
  } catch (e) { setIdentity('无法获取身份', String((e && e.message) || e)); }
}
el('identity-refresh').onclick = function(){ loadIdentity(); };
el('identity-confirm').onclick = startHandshake;
async function update(increment){
  try {
    var r = await fetch(increment ? 'api/increment' : 'api/state', { method: increment ? 'POST' : 'GET' });
    if (!r.ok) throw Error('请求失败 ' + r.status);
    var s = await r.json(); el('count').textContent = s.count; el('error').textContent = '';
  } catch (e) { el('error').textContent = e.message; }
}
el('add').onclick = function(){ update(true); };
update(false);
var stream = new EventSource('events');
stream.onmessage = function(e){ el('stream').textContent = '实时事件流正常 · ' + JSON.parse(e.data).tick; };
stream.onerror = function(){ el('stream').textContent = '事件流断开，等待恢复'; };
loadIdentity();
</script></html>`;

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
  if (url.pathname === '/' && req.method === 'GET') return reply(200, page, 'text/html; charset=utf-8');
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
