// Real nginx integration. Explicit opt-in so ordinary Node CI needs no Docker.
// CAG_NGINX_TEST=1 pnpm test (uses the already installed nginx:alpine image).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';
import { renderGateway } from '../src/gateway-config.mjs';

const html = '<!doctype html><html><head lang="en"><title>fixture</title></head><body><button id="pick">Hello</button></body></html>';
const scriptPath = '/_catsco/runtime/annotations-v1.js';
const rendererPath = '/_catsco/runtime/html2canvas-1.4.1.min.js';
const image = process.env.CAG_NGINX_IMAGE || 'nginx:alpine';
// Only for a pre-freeze route rehearsal against an explicitly staged asset
// directory; the shipped assertions always use the exported vendor directory.
const runtimeDir = path.resolve(process.env.CAG_RUNTIME_DIR || 'public/runtime');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(base, url, headers = {}, method = 'GET') {
  // Exercise the real 10r/s limiter without making the fixture trigger it.
  await sleep(110);
  return new Promise((resolve, reject) => {
    const req = http.request(base + url, { headers, method }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('real rendered nginx: injection, static runtime, compression, CSP and bypasses', { skip: process.env.CAG_NGINX_TEST !== '1', timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-nginx-'));
  const name = `cag-annotation-test-${process.pid}-${Date.now()}`;
  const upstreamSeen = [];
  const server = http.createServer((req, res) => {
    upstreamSeen.push({ url: req.url, headers: req.headers });
    const url = req.url.split('?')[0];
    let body = html, status = 200;
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ETag: '"upstream"', 'Last-Modified': 'Tue, 01 Jan 2030 00:00:00 GMT', 'Content-Security-Policy': "script-src 'none'; object-src 'none'", 'X-Upstream': 'kept' };
    if (url === '/no-head') body = '<html><body>Fallback</body></html>';
    if (url === '/upper') body = html.toUpperCase();
    if (url === '/no-markers') body = 'Plain HTML fragment';
    if (url === '/json') { body = '{"head":"</head>"}'; headers['Content-Type'] = 'application/json'; }
    if (url === '/css') { body = '/* </head> */'; headers['Content-Type'] = 'text/css'; }
    if (url === '/javascript') { body = 'const x="</head>";'; headers['Content-Type'] = 'application/javascript'; }
    if (url === '/xhtml') headers['Content-Type'] = 'application/xhtml+xml';
    if (url === '/odd-content-type') headers['Content-Type'] = 'text/html-extra';
    if (url === '/latin') headers['Content-Type'] = 'text/html; charset=iso-8859-1';
    if (url === '/download') headers['Content-Disposition'] = 'attachment; filename="page.html"';
    if (url === '/no-transform') headers['Cache-Control'] += ', no-transform';
    if (url === '/big') body = '<head></head>' + 'x'.repeat(1000000) + '</body>';
    if (url === '/error') status = 500;
    if (url === '/range') { status = 206; headers['Content-Range'] = 'bytes 0-9/100'; body = '</head>xx'; }
    if (url === '/sse') headers['Content-Type'] = 'text/event-stream';
    if (url === '/gzip') { body = gzipSync(Buffer.from(html)); headers['Content-Encoding'] = 'gzip'; }
    if (url === '/negotiated' && req.headers['accept-encoding']?.includes('gzip')) { body = gzipSync(Buffer.from(html)); headers['Content-Encoding'] = 'gzip'; }
    if (url === '/chunked' || url === '/sse') { res.writeHead(status, headers); res.write(body.slice(0, 20)); res.end(body.slice(20)); return; }
    headers['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(status, headers); res.end(body);
  });
  const wsServer = new WebSocketServer({ server });
  wsServer.on('connection', socket => socket.on('message', bytes => socket.send(bytes.toString())));
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  let started = false;
  try {
    const appPort = server.address().port;
    const config = { sshPort: 22443, user: 'cag', publicHosts: ['artifact.catsco.cc'], hostKey: '/etc/cag/key', authorizedKeys: '/etc/cag/keys', annotationRuntime: { enabled: true, defaultEnabled: true, directory: '/runtime', parentOrigins: ['https://app.catsco.cc'] }, apps: [{ id: 'demo', remotePort: appPort, publicKey: 'ssh-ed25519 AAAATEST' }, { id: 'plain', remotePort: appPort + 1, publicKey: 'ssh-ed25519 AAAAOTHER', annotations: false }] };
    const out = renderGateway(config);
    // A container's loopback is not the test host. Only change transport target;
    // injection/filter/resource/header directives are the real renderer output.
    const locations = out.locations.replaceAll(`127.0.0.1:${appPort}/`, `host.docker.internal:${appPort}/`).replaceAll(`127.0.0.1:${appPort + 1}/`, `host.docker.internal:${appPort}/`);
    fs.writeFileSync(path.join(dir, 'nginx.conf'), `events {}\nhttp { gzip on; gzip_min_length 1; gzip_types application/javascript; access_log off; error_log /dev/stderr notice; ${out.nginx}\nserver { listen 8080; ${locations}\n} }`);
    const syntax = spawnSync('docker', ['run', '--rm', '--entrypoint', 'nginx', '-v', `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${runtimeDir}:/runtime:ro`, image, '-t'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(syntax.status, 0, syntax.stderr);
    t.diagnostic(syntax.stderr.trim());
    docker('run', '-d', '--rm', '--name', name, '--entrypoint', 'nginx', '-p', '127.0.0.1::8080', '-v', `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`, `-v`, `${runtimeDir}:/runtime:ro`, image, '-g', 'daemon off;');
    started = true;
    const port = docker('port', name, '8080/tcp').split(':').at(-1);
    const base = `http://127.0.0.1:${port}`;
    let first;
    for (let i = 0; i < 30; i++) { try { first = await request(base, '/demo/'); break; } catch { await sleep(100); } }
    assert.equal(first?.status, 200, first?.body.toString());
    assert.equal(first.body.toString().split(scriptPath).length - 1, 2, 'head plus body singleton-safe fallback');
    assert.ok(first.body.toString().includes('data-catsco-parent-origins="[&quot;https://app.catsco.cc&quot;]"'));
    assert.equal(first.headers['content-length'], undefined);
    assert.equal(first.headers.etag, undefined);
    assert.equal(first.headers['last-modified'], undefined);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.headers['content-encoding'], undefined);
    assert.equal(first.headers['x-upstream'], 'kept');
    assert.ok(first.headers['content-security-policy'].startsWith("script-src 'none'; object-src 'none'"), 'restrictive upstream CSP retained, SDK naturally blocked by browsers');
    assert.equal(upstreamSeen[0].headers['accept-encoding'], undefined);
    t.diagnostic(JSON.stringify({ html_status: first.status, injected_tags: 2, content_length: first.headers['content-length'] ?? null, etag: first.headers.etag ?? null, cache_control: first.headers['cache-control'], csp: first.headers['content-security-policy'] }));
    for (const url of ['/no-head', '/upper']) {
      const res = await request(base, '/demo' + url); assert.ok(res.body.toString().includes(scriptPath), url);
    }
    for (const url of ['/no-markers', '/json', '/css', '/javascript', '/xhtml', '/odd-content-type', '/latin', '/download', '/no-transform', '/big', '/error', '/range', '/sse', '/chunked']) {
      const res = await request(base, '/demo' + url); assert.ok(!res.body.toString().includes(scriptPath), url);
    }
    const compressed = await request(base, '/demo/gzip', { 'Accept-Encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.deepEqual(compressed.body, gzipSync(Buffer.from(html)), 'upstream ignoring identity passes compressed bytes unchanged');
    assert.equal(compressed.headers['content-length'], String(compressed.body.length));
    const range = await request(base, '/demo/range', { Range: 'bytes=0-9' });
    assert.equal(range.status, 206); assert.equal(range.headers['content-range'], 'bytes 0-9/100'); assert.ok(!range.body.toString().includes(scriptPath));
    const negotiated = await request(base, '/demo/negotiated', { 'Accept-Encoding': 'gzip', 'Sec-Fetch-Dest': 'iframe' });
    assert.equal(negotiated.headers['content-encoding'], 'gzip', 'downstream gzip runs after injection');
    assert.ok(gunzipSync(negotiated.body).toString().includes(scriptPath));
    assert.equal(upstreamSeen.at(-1).headers['accept-encoding'], undefined);
    const assetRequest = await request(base, '/demo/negotiated', { 'Accept-Encoding': 'gzip', 'Sec-Fetch-Dest': 'script', 'If-None-Match': '"asset"' });
    assert.equal(assetRequest.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(assetRequest.body).toString(), html);
    assert.equal(upstreamSeen.at(-1).headers['accept-encoding'], 'gzip');
    assert.equal(upstreamSeen.at(-1).headers['if-none-match'], '"asset"');
    const conditional = await request(base, '/demo/', { 'If-None-Match': '"upstream"', 'If-Modified-Since': 'Tue, 01 Jan 2030 00:00:00 GMT' });
    assert.equal(conditional.status, 200); assert.equal(upstreamSeen.at(-1).headers['if-none-match'], undefined);
    const plain = await request(base, '/plain/'); assert.equal(plain.body.toString(), html);
    const asset = await request(base, scriptPath + '?url=https://evil.invalid&open_ref=ignored', { Cookie: '__Host-aid=ignored' });
    assert.equal(asset.status, 200); assert.equal(asset.headers['content-type'], 'application/javascript');
    assert.equal(asset.headers['x-content-type-options'], 'nosniff'); assert.equal(asset.headers['cache-control'], 'public, max-age=0, must-revalidate');
    assert.deepEqual(asset.body, fs.readFileSync(path.join(runtimeDir, 'annotations-v1.js')));
    t.diagnostic(JSON.stringify({ runtime_status: asset.status, bytes: asset.body.length, type: asset.headers['content-type'], cache_control: asset.headers['cache-control'], nosniff: asset.headers['x-content-type-options'], forced_upstream_gzip_unchanged: true, downstream_gzip_after_injection: true, chunked_html_injected: false, download_injected: false }));
    assert.ok(!asset.body.toString().includes('open_ref=ignored'));
    assert.equal((await request(base, scriptPath, {}, 'HEAD')).status, 200);
    assert.equal((await request(base, scriptPath, {}, 'POST')).status, 403);
    for (const url of ['/_catsco/runtime/evil.js', '/_catsco/runtime/annotations-v2.js', '/_catsco/runtime/annotations-v1.manifest.json']) assert.equal((await request(base, url)).status, 404);
    const cached = await request(base, scriptPath, { 'If-None-Match': asset.headers.etag }); assert.equal(cached.status, 304);
    const renderer = await request(base, rendererPath + '?url=https://cdn.invalid/evil.js', { 'Accept-Encoding': 'gzip', Cookie: '__Host-aid=ignored' });
    assert.equal(renderer.status, 200);
    assert.equal(renderer.headers['content-type'], 'application/javascript');
    assert.equal(renderer.headers['cache-control'], 'public, max-age=0, must-revalidate');
    assert.equal(renderer.headers['x-content-type-options'], 'nosniff');
    assert.equal(renderer.headers['content-encoding'], undefined);
    assert.equal(renderer.headers['content-length'], String(renderer.body.length));
    assert.equal(renderer.headers['set-cookie'], undefined);
    assert.deepEqual(renderer.body, fs.readFileSync(path.join(runtimeDir, 'html2canvas-1.4.1.min.js')));
    assert.ok(renderer.body.toString().includes('html2canvas 1.4.1'));
    assert.equal((await request(base, rendererPath, { 'If-None-Match': renderer.headers.etag })).status, 304);
    assert.equal((await request(base, rendererPath, {}, 'HEAD')).status, 200);
    assert.equal((await request(base, rendererPath, {}, 'POST')).status, 403);
    for (const url of ['/_catsco/runtime/html2canvas-1.4.0.min.js', '/_catsco/runtime/html2canvas-1.4.1.LICENSE', '/_catsco/runtime/html2canvas-1.4.1.min.js/extra']) assert.equal((await request(base, url)).status, 404);
    t.diagnostic(JSON.stringify({ renderer_status: renderer.status, renderer_bytes: renderer.body.length, renderer_sha256: createHash('sha256').update(renderer.body).digest('hex'), type: renderer.headers['content-type'], cache_control: renderer.headers['cache-control'], nosniff: renderer.headers['x-content-type-options'], source: 'fixed same-origin alias, no CDN proxy' }));
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/demo/socket');
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS proxy timeout')); }, 5000);
      socket.on('open', () => socket.send('unchanged websocket'));
      socket.on('message', data => { clearTimeout(timer); assert.equal(data.toString(), 'unchanged websocket'); socket.close(); resolve(); });
      socket.on('error', reject);
    });
    // Execute the actual HTTP-served bytes with a minimal DOM-less harness:
    // proves attribute decode, duplicate singleton, and FIRST connect forwarding.
    // Browser DOM capture/CSP enforcement belongs to D + final cross-repo E2E.
    const listeners = new Map(), posted = [];
    const context = vm.createContext({ URL, console, document: { currentScript: { getAttribute: () => '["https://app.catsco.cc"]' }, addEventListener() {}, removeEventListener() {} }, history: { pushState() {}, replaceState() {} } });
    vm.runInContext(`window = globalThis; window.parent = { postMessage: function (message, origin) { _post(message, origin); } }; window.location = { pathname: '/demo/' }; window.getSelection = function () { return null; }; window.addEventListener = _add; window.removeEventListener = _remove;`, Object.assign(context, {
      _post: (message, origin) => posted.push({ message, origin }),
      _add: (type, listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      _remove: (type, listener) => listeners.get(type)?.delete(listener),
    }));
    vm.runInContext(asset.body.toString(), context);
    vm.runInContext(asset.body.toString(), context);
    const send = (origin, source) => {
      context._origin = origin; context._source = source;
      const event = vm.runInContext(`({origin: _origin, source: _source, data: {contract_version: 'catsco.gateway-annotation-bridge.v1', type: 'catsco.gateway.annotation.connect.v1', session_id: 'doc-1', request_id: 'req-1'}})`, context);
      for (const fn of [...listeners.get('message')]) fn(event);
    };
    send('https://evil.example', context.parent);
    send('https://app.catsco.cc', {});
    assert.equal(posted.length, 0);
    send('https://app.catsco.cc', context.parent);
    assert.equal(posted.length, 1, 'first allowed connect is not swallowed');
    assert.equal(posted[0].message.type, 'catsco.gateway.annotation.ready.v1');
    assert.equal(posted[0].message.request_id, 'req-1');
    assert.equal(posted[0].message.session_id, 'doc-1');
    assert.equal(posted[0].origin, 'https://app.catsco.cc');
    vm.runInContext('CatsCoAnnotations.dispose()', context);
    t.diagnostic('nginx -t and live renderer HTTP assertions passed; container removed in finally');
  } finally {
    if (started) docker('rm', '-f', name);
    for (const socket of wsServer.clients) socket.terminate();
    wsServer.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
