import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { renderGateway } from '../src/gateway-config.mjs';
import { webmcpRuntime, webmcpRuntimeScript } from '../src/webmcp-runtime.mjs';
import { createControlPlane } from '../src/control-plane.mjs';
import { ViewerStore } from '../src/viewer-store.mjs';

const runtime = {
  enabled: true,
  directory: '/opt/catsco-artifact-gateway/public/runtime',
  parentOrigins: ['https://app.catsco.cc', 'https://app.catsco.cn'],
};
const gateway = {
  sshPort: 22443,
  user: 'cag',
  publicHosts: ['artifact.catsco.cc'],
  hostKey: '/etc/cag/key',
  authorizedKeys: '/etc/cag/keys',
  apps: [
    { id: 'canvas', remotePort: 28191, publicKey: 'ssh-ed25519 AAAACANVAS canvas', webmcp: true },
    { id: 'plain', remotePort: 28192, publicKey: 'ssh-ed25519 AAAAPLAIN plain' },
  ],
};

test('webmcpRuntime and each application require independent explicit opt-in', () => {
  for (const config of [gateway, { ...gateway, webmcpRuntime: { enabled: false } }]) {
    const out = renderGateway(config);
    assert.ok(!out.locations.includes('sub_filter'));
    assert.ok(!out.locations.includes('/_catsco/runtime/'));
    assert.ok(!out.nginx.includes('cag_annotation'));
  }
  const out = renderGateway({ ...gateway, webmcpRuntime: runtime });
  assert.ok(out.locations.includes('location = /_catsco/runtime/webmcp-v1.js'));
  assert.ok(out.locations.includes(`alias ${runtime.directory}/webmcp-v1.js;`));
  assert.equal((out.locations.match(/location = \/_catsco\/runtime\//g) || []).length, 1);
  assert.equal((out.locations.match(/location \^~ \/_catsco\/runtime\//g) || []).length, 1);
  const [enabledApp, plainApp] = out.locations.split('location ^~ /canvas/')[1].split('location = /plain');
  assert.ok(enabledApp.includes('sub_filter'));
  assert.ok(enabledApp.includes('/_catsco/runtime/webmcp-v1.js'));
  assert.ok(!plainApp.includes('sub_filter'));
});

test('webmcpRuntime defaultEnabled enables apps while explicit webmcp: false opts out', () => {
  const config = {
    ...gateway,
    webmcpRuntime: { ...runtime, defaultEnabled: true },
    apps: [
      ...gateway.apps,
      { id: 'off', remotePort: 28193, publicKey: 'ssh-ed25519 AAAAOFF off', webmcp: false },
    ],
  };
  const out = renderGateway(config);
  assert.equal((out.locations.match(/sub_filter_once on/g) || []).length, 2);
  assert.ok(out.locations.split('location ^~ /plain/')[1].split('location = /off')[0].includes('/_catsco/runtime/webmcp-v1.js'));
  assert.ok(!out.locations.split('location ^~ /off/')[1].includes('sub_filter'));
  assert.equal(out.sshd, renderGateway({ ...config, webmcpRuntime: undefined }).sshd);
  assert.equal(out.authorizedKeys, renderGateway({ ...config, webmcpRuntime: undefined }).authorizedKeys);
});

test('annotationRuntime and webmcpRuntime coexist cleanly without duplicate nginx directives', () => {
  const config = {
    ...gateway,
    annotationRuntime: { ...runtime, defaultEnabled: false },
    webmcpRuntime: { ...runtime, defaultEnabled: false },
    apps: [
      { id: 'both', remotePort: 28191, publicKey: 'ssh-ed25519 AAAABOTH both', annotations: true, webmcp: true },
      { id: 'only-ann', remotePort: 28192, publicKey: 'ssh-ed25519 AAAAANN only-ann', annotations: true },
      { id: 'only-mcp', remotePort: 28193, publicKey: 'ssh-ed25519 AAAAMCP only-mcp', webmcp: true },
    ],
  };
  const out = renderGateway(config);
  // 3 annotation assets + 1 webmcp asset, and only ONE catch-all 404.
  assert.equal((out.locations.match(/location = \/_catsco\/runtime\//g) || []).length, 4);
  assert.equal((out.locations.match(/location \^~ \/_catsco\/runtime\//g) || []).length, 1);

  const bothBlock = out.locations.split('location ^~ /both/')[1].split('location = /only-ann')[0];
  assert.equal((bothBlock.match(/sub_filter_once on/g) || []).length, 1);
  assert.equal((bothBlock.match(/sub_filter \$cag_annotation_head/g) || []).length, 1);
  assert.equal((bothBlock.match(/sub_filter \$cag_annotation_body/g) || []).length, 1);
  assert.ok(bothBlock.includes('/_catsco/runtime/annotations-v1.js'));
  assert.ok(bothBlock.includes('/_catsco/runtime/webmcp-v1.js'));

  const annBlock = out.locations.split('location ^~ /only-ann/')[1].split('location = /only-mcp')[0];
  assert.ok(annBlock.includes('/_catsco/runtime/annotations-v1.js'));
  assert.ok(!annBlock.includes('/_catsco/runtime/webmcp-v1.js'));

  const mcpBlock = out.locations.split('location ^~ /only-mcp/')[1];
  assert.ok(!mcpBlock.includes('/_catsco/runtime/annotations-v1.js'));
  assert.ok(mcpBlock.includes('/_catsco/runtime/webmcp-v1.js'));
});

test('webmcpRuntime rejects malformed origins, directories, unknown keys and non-boolean flags', () => {
  for (const origin of ['*', 'null', 'https://app.catsco.cc/', 'https://app.catsco.cc/path', 'http://app.catsco.cc', 'https://app.catsco.cc?x']) {
    assert.throws(() => webmcpRuntime({ webmcpRuntime: { ...runtime, parentOrigins: [origin] } }), String(origin));
  }
  for (const directory of ['/tmp/x; return 200;', '/tmp/$host', '/tmp/../secret', 'relative']) {
    assert.throws(() => webmcpRuntime({ webmcpRuntime: { ...runtime, directory } }));
  }
  for (const patch of [{ enabled: 'true' }, { defaultEnabled: 1 }, { parentOrigins: [] }, { unknown: true }]) {
    assert.throws(() => webmcpRuntime({ webmcpRuntime: { ...runtime, ...patch } }));
  }
  for (const webmcp of ['true', 1, {}, null]) {
    assert.throws(() => renderGateway({ ...gateway, apps: [{ ...gateway.apps[0], webmcp }] }));
  }
  const tag = webmcpRuntimeScript(webmcpRuntime({ webmcpRuntime: runtime }));
  assert.match(tag, /^<script src="\/_catsco\/runtime\/webmcp-v1\.js" data-catsco-parent-origins="\[&quot;/);
  assert.ok(!/open_ref|topic|token|cookie|referrer|document\./i.test(tag));
});

test('control-plane registration cannot enable webmcp and preserves operator-owned webmcp flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-webmcp-cp-'));
  const configPath = path.join(dir, 'gateway.json');
  const statePath = path.join(dir, 'viewers.json');
  const initial = {
    ...gateway,
    controlPort: 22445,
    webmcpRuntime: runtime,
    apps: [
      { id: 'canvas', title: 'Canvas', agent: '365', remotePort: 28191, publicKey: 'ssh-ed25519 AAAACANVAS canvas', webmcp: true },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));
  const store = new ViewerStore({ file: statePath });
  const server = createControlPlane({
    config: initial,
    configPath,
    controlToken: 'test-control-token-0123456789abcdef01',
    cookieSecure: false,
    corsOrigins: ['https://app.catsco.cc'],
    store,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    // Update existing app trying to set webmcp: false -> must preserve true.
    const updateRes = await fetch(`${base}/_gateway/apps`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-control-token-0123456789abcdef01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'canvas', title: 'Canvas v2', agent: '365', webmcp: false }),
    });
    assert.equal(updateRes.status, 201);
    // Register new app trying to set webmcp: true -> must ignore caller flag.
    const createRes = await fetch(`${base}/_gateway/apps`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-control-token-0123456789abcdef01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'fresh', title: 'Fresh', agent: '365', publicKey: 'ssh-ed25519 AAAAFRESH fresh', webmcp: true }),
    });
    assert.equal(createRes.status, 201);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.apps.find(a => a.id === 'canvas').webmcp, true);
    assert.equal(saved.apps.find(a => a.id === 'fresh').webmcp, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vendored webmcp-v1.js matches manifest sha256 and works end-to-end in VM harness', async () => {
  const dir = new URL('../public/runtime/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('webmcp-v1.manifest.json', dir), 'utf8'));
  const bytes = fs.readFileSync(new URL('webmcp-v1.js', dir));
  const code = bytes.toString('utf8');

  assert.equal(manifest.runtime_path, '/_catsco/runtime/webmcp-v1.js');
  assert.equal(manifest.config_attribute, 'data-catsco-parent-origins');
  assert.equal(manifest.bytes, bytes.length);
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(!/\bfetch\s*\(|\bWebSocket\b/i.test(code), 'shim must never talk to the network');

  // Build minimal DOM / window / navigator VM harness
  const listeners = new Set();
  const posted = [];
  const nativeCalls = [];
  const parentWin = {
    postMessage(msg, targetOrigin) {
      posted.push({ msg, targetOrigin });
    },
  };
  const win = {
    parent: parentWin,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
  };
  const nav = {
    modelContext: {
      registerTool(t) { nativeCalls.push(['registerTool', t.name]); },
      unregisterTool(n) { nativeCalls.push(['unregisterTool', n]); },
      provideContext(o) { nativeCalls.push(['provideContext', o.tools.length]); },
      clearContext() { nativeCalls.push(['clearContext']); },
    },
  };
  const currentScript = {
    getAttribute(attr) {
      return attr === 'data-catsco-parent-origins' ? '["https://app.catsco.cc"]' : null;
    },
  };
  const sandbox = {
    window: win,
    navigator: nav,
    document: { currentScript },
    URL,
    Promise,
    Map,
    Set,
    Array,
    Object,
    JSON,
    Error,
    String,
  };
  vm.createContext(sandbox);

  // Simulate double injection (</head> + </body>)
  vm.runInContext(code, sandbox);
  vm.runInContext(code, sandbox);
  assert.equal(listeners.size, 1, 'double injection must not register duplicate listeners');

  // Register tool BEFORE host connect (boot-time registration)
  nav.modelContext.registerTool({
    name: 'relayout',
    description: 'Arrange canvas nodes',
    inputSchema: { type: 'object', properties: { mode: { type: 'string' } } },
    async execute(args) {
      return { ok: true, mode: args.mode };
    },
  });
  assert.deepEqual(nativeCalls, [['registerTool', 'relayout']], 'must dual-write to native navigator.modelContext');

  const dispatch = (origin, data, source = parentWin) => {
    for (const fn of [...listeners]) fn({ origin, source, data });
  };

  // Non-allowlisted origin must be ignored
  dispatch('https://evil.example', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.connect.v1',
    session_id: 'sess-1',
    request_id: 'req-0',
  });
  assert.equal(posted.length, 0);

  const plain = value => JSON.parse(JSON.stringify(value));

  // Valid connect -> ready with pre-registered tools
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.connect.v1',
    session_id: 'sess-1',
    request_id: 'req-1',
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].targetOrigin, 'https://app.catsco.cc');
  assert.equal(posted[0].msg.type, 'catsco.gateway.webmcp.ready.v1');
  assert.equal(posted[0].msg.session_id, 'sess-1');
  assert.deepEqual(plain(posted[0].msg.tools.map(t => t.name)), ['relayout']);

  // Dynamic tool registration pushes tools_sync
  nav.modelContext.registerTool({
    name: 'fail_tool',
    description: 'Throws',
    execute() { throw new Error('boom'); },
  });
  assert.equal(posted.at(-1).msg.type, 'catsco.gateway.webmcp.tools_sync.v1');
  assert.deepEqual(plain(posted.at(-1).msg.tools.map(t => t.name)), ['relayout', 'fail_tool']);

  // Tool call -> structured tool_result
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-1',
    call_id: 'call-1',
    name: 'relayout',
    arguments: { mode: 'grid' },
  });
  await new Promise(resolve => setImmediate(resolve));
  const res1 = plain(posted.at(-1).msg);
  assert.equal(res1.type, 'catsco.gateway.webmcp.tool_result.v1');
  assert.equal(res1.call_id, 'call-1');
  assert.equal(res1.is_error, false);
  assert.deepEqual(res1.structured_content, { ok: true, mode: 'grid' });

  // Throwing tool -> structured tool_execution_error
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-1',
    call_id: 'call-2',
    name: 'fail_tool',
    arguments: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const res2 = plain(posted.at(-1).msg);
  assert.equal(res2.is_error, true);
  assert.equal(res2.error.code, 'tool_execution_error');
  assert.equal(res2.error.message, 'boom');

  // Unknown tool -> tool_not_found
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-1',
    call_id: 'call-3',
    name: 'missing',
    arguments: {},
  });
  const res3 = plain(posted.at(-1).msg);
  assert.equal(res3.is_error, true);
  assert.equal(res3.error.code, 'tool_not_found');

  // Wrong session_id must be ignored
  const countBefore = posted.length;
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.ping.v1',
    session_id: 'wrong-session',
    request_id: 'p-bad',
  });
  assert.equal(posted.length, countBefore);

  // Valid ping -> pong
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.ping.v1',
    session_id: 'sess-1',
    request_id: 'p-1',
  });
  assert.equal(posted.at(-1).msg.type, 'catsco.gateway.webmcp.pong.v1');
  assert.equal(posted.at(-1).msg.request_id, 'p-1');

  // Unregister tool -> tools_sync
  nav.modelContext.unregisterTool('fail_tool');
  assert.equal(posted.at(-1).msg.type, 'catsco.gateway.webmcp.tools_sync.v1');
  assert.deepEqual(plain(posted.at(-1).msg.tools.map(t => t.name)), ['relayout']);

  // G1: async tool_result must be dropped if host reconnects with a new session_id while in flight
  let resolveSlow;
  nav.modelContext.registerTool({
    name: 'slow_tool',
    description: 'Resolves after reconnect',
    execute() {
      return new Promise(resolve => { resolveSlow = resolve; });
    },
  });
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-1',
    call_id: 'call-stale',
    name: 'slow_tool',
    arguments: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  // Host reconnects with sess-2 before slow_tool resolves
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.connect.v1',
    session_id: 'sess-2',
    request_id: 'req-2',
  });
  const countAfterReconnect = posted.length;
  resolveSlow({ stale: true });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.length, countAfterReconnect, 'stale tool_result from previous session must be dropped');

  // G2: UTF-8 byte cap (48 KiB) rejects multibyte payloads even when UTF-16 length < 48 KiB
  nav.modelContext.registerTool({
    name: 'big_utf8',
    description: 'Returns >48 KiB UTF-8 payload',
    execute() {
      // 20,000 CJK chars = 20,000 UTF-16 code units (< 48 KiB) but 60,000 UTF-8 bytes (> 48 KiB)
      return '中'.repeat(20000);
    },
  });
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-2',
    call_id: 'call-big',
    name: 'big_utf8',
    arguments: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const bigRes = plain(posted.at(-1).msg);
  assert.equal(bigRes.session_id, 'sess-2');
  assert.equal(bigRes.is_error, true);
  assert.equal(bigRes.error.code, 'result_too_large');

  // G3: error messages & tool_not_found echoes are bounded; provideContext throws past 64 tools
  nav.modelContext.registerTool({
    name: 'long_err',
    description: 'Throws huge error',
    execute() { throw new Error('E'.repeat(2000)); },
  });
  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-2',
    call_id: 'call-long-err',
    name: 'long_err',
    arguments: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const errRes = plain(posted.at(-1).msg);
  assert.equal(errRes.is_error, true);
  assert.ok(errRes.error.message.length <= 512, 'error message must be bounded');

  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.tool_call.v1',
    session_id: 'sess-2',
    call_id: 'call-long-missing',
    name: 'x'.repeat(500),
    arguments: {},
  });
  const missingRes = plain(posted.at(-1).msg);
  assert.equal(missingRes.error.code, 'tool_not_found');
  assert.ok(missingRes.error.message.length <= 160, 'tool_not_found echo must be bounded');

  assert.throws(() => {
    nav.modelContext.provideContext({
      tools: Array.from({ length: 65 }, (_, i) => ({
        name: `t_${i}`,
        description: 'd',
        execute() { return i; },
      })),
    });
  }, /Maximum WebMCP tools limit/);

  // Follow-up: 64 tools with 1024-char descriptions are byte-capped <= 48 KiB on both tools_sync and ready
  nav.modelContext.provideContext({
    tools: Array.from({ length: 64 }, (_, i) => ({
      name: `heavy_${i}`,
      description: 'D'.repeat(1024),
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      execute() { return i; },
    })),
  });
  const syncHeavy = plain(posted.at(-1).msg);
  assert.equal(syncHeavy.type, 'catsco.gateway.webmcp.tools_sync.v1');
  assert.equal(syncHeavy.tools_truncated, true);
  assert.ok(syncHeavy.tools.length < 64 && syncHeavy.tools.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(syncHeavy.tools), 'utf8') <= 48 * 1024);

  dispatch('https://app.catsco.cc', {
    contract_version: 'catsco.gateway-webmcp-bridge.v1',
    type: 'catsco.gateway.webmcp.connect.v1',
    session_id: 'sess-3',
    request_id: 'req-3',
  });
  const readyHeavy = plain(posted.at(-1).msg);
  assert.equal(readyHeavy.type, 'catsco.gateway.webmcp.ready.v1');
  assert.equal(readyHeavy.tools_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(readyHeavy.tools), 'utf8') <= 48 * 1024);
});
