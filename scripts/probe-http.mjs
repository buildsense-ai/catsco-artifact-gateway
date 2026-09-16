import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
const base = process.argv[2];
const expectedApp = process.argv[3];
const get = async path => {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(12000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`); return response;
};
const health = await (await get('health')).json();
assert.equal(health.appId, expectedApp); assert.notEqual(health.uid, 0);
const initial = await (await get('api/state')).json();
const post = await fetch(new URL('api/increment', base), { method: 'POST', signal: AbortSignal.timeout(12000) });
assert.equal(post.status, 200); const changed = await post.json(); assert.equal(changed.count, initial.count + 1);
const refreshed = await (await get('api/state')).json(); assert.equal(refreshed.count, changed.count);
const file = await get('download'); assert.match(file.headers.get('content-disposition'), /attachment/);
const bytes = Buffer.from(await file.arrayBuffer()); assert.equal(JSON.parse(bytes).count, changed.count);
const events = await fetch(new URL('events', base), { signal: AbortSignal.timeout(12000) });
assert.equal(events.status, 200); const reader = events.body.getReader(); let chunks = '';
while ((chunks.match(/data:/g) || []).length < 2) { const value = await reader.read(); if (value.done) break; chunks += Buffer.from(value.value).toString(); }
assert.ok((chunks.match(/data:/g) || []).length >= 2); await reader.cancel();
await new Promise((resolve, reject) => {
  const target = new URL('ws', base); target.protocol = 'wss:';
  const ws = new WebSocket(target, { handshakeTimeout: 10000 });
  const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket message timeout')); }, 12000);
  ws.on('message', bytes => { try { assert.equal(JSON.parse(bytes.toString()).appId, expectedApp); clearTimeout(timeout); ws.close(); resolve(); } catch (e) { clearTimeout(timeout); ws.terminate(); reject(e); } });
  ws.on('error', e => { clearTimeout(timeout); reject(e); });
});
console.log(JSON.stringify({ ok: true, appId: expectedApp, uid: health.uid, counter: refreshed.count, downloadSha256: crypto.createHash('sha256').update(bytes).digest('hex'), sse: 'passed', websocket: 'passed' }));
