import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { createTunnelServer } from '../src/ws-gateway.mjs';
import { tunnelMaxConnections, DEFAULT_TUNNEL_MAX_CONNECTIONS } from '../src/config.mjs';

// Each case starts a real adapter on an ephemeral port and talks to it over a real
// websocket, because the behaviour under test — refusing the Nth connection while
// keeping the first N-1 alive — is exactly what a unit-level stub would paper over.

// A stand-in for the loopback sshd the adapter forwards to. It accepts and holds
// the connection so an upgraded tunnel stays open.
function fakeUpstream() {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    server,
    sockets,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => { for (const s of sockets) s.destroy(); return new Promise(resolve => server.close(resolve)); },
  };
}

async function withGateway(options, run) {
  const upstream = fakeUpstream();
  const sshPort = await upstream.listen();
  const { server, wss, limit } = createTunnelServer({ maxConnections: options.maxConnections, sshPort });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await run({ port, limit, wss });
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    await upstream.close();
  }
}

// Resolves with the outcome of one upgrade attempt: the socket opening, or the
// HTTP status when the adapter refuses it.
function attempt(port) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', error => resolve({ ok: false, error }));
  });
}

test('the tunnel limit defaults to the shared ceiling, not a per-account quota', () => {
  // The pool is global: the tunnel URL carries no identity, so the only thing the
  // adapter can count is every connection it holds.
  assert.equal(tunnelMaxConnections(undefined), DEFAULT_TUNNEL_MAX_CONNECTIONS);
  assert.equal(DEFAULT_TUNNEL_MAX_CONNECTIONS, 160);
});

test('the tunnel limit is configurable and rejects nonsense', () => {
  assert.equal(tunnelMaxConnections('5'), 5);
  assert.equal(tunnelMaxConnections(256), 256);
  // An empty value means "not configured", which must fall back rather than fail:
  // the unit file may pass the variable through without a value.
  assert.equal(tunnelMaxConnections(''), DEFAULT_TUNNEL_MAX_CONNECTIONS);
  assert.equal(tunnelMaxConnections(null), DEFAULT_TUNNEL_MAX_CONNECTIONS);
  for (const bad of ['0', '-1', 'abc', '1.5', '4097', '999999', 0, -5, {}, []]) {
    assert.throws(() => tunnelMaxConnections(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('connections up to the limit are accepted', async () => {
  await withGateway({ maxConnections: 3 }, async ({ port }) => {
    const opened = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await attempt(port);
      assert.equal(result.ok, true, `connection ${i + 1} of 3 should be accepted`);
      opened.push(result.ws);
    }
    for (const ws of opened) ws.terminate();
  });
});

test('the connection past the limit is refused with 403 and the earlier ones stay open', async () => {
  await withGateway({ maxConnections: 2 }, async ({ port }) => {
    const first = await attempt(port);
    const second = await attempt(port);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    const third = await attempt(port);
    assert.equal(third.ok, false, 'the third connection must be refused');
    assert.equal(third.status, 403);

    // Refusing the newcomer must not disturb what is already tunnelling: the
    // applications that hold a slot keep working through the burst.
    assert.equal(first.ws.readyState, WebSocket.OPEN);
    assert.equal(second.ws.readyState, WebSocket.OPEN);

    first.ws.terminate();
    second.ws.terminate();
  });
});

test('a closed tunnel frees its slot', async () => {
  await withGateway({ maxConnections: 2 }, async ({ port }) => {
    const first = await attempt(port);
    const second = await attempt(port);
    assert.equal(second.ok, true);

    // Fill the pool, then release one slot and confirm it becomes usable again.
    // Without this, a connection that closed without being counted out would
    // shrink the pool permanently and reproduce the original complaint.
    const blocked = await attempt(port);
    assert.equal(blocked.ok, false);

    first.ws.terminate();
    await new Promise(resolve => setTimeout(resolve, 150));

    const afterRelease = await attempt(port);
    assert.equal(afterRelease.ok, true, 'a released slot must be reusable');
    second.ws.terminate();
    afterRelease.ws.terminate();
  });
});

test('the health endpoint reports the live count and the configured limit', async () => {
  await withGateway({ maxConnections: 7 }, async ({ port }) => {
    const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(before.ok, true);
    assert.equal(before.activeConnections, 0);
    assert.equal(before.maxConnections, 7);

    const ws = await attempt(port);
    assert.equal(ws.ok, true);
    const during = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(during.activeConnections, 1);
    ws.ws.terminate();
  });
});

test('only the tunnel path is upgraded, and a browser origin is refused', async () => {
  await withGateway({ maxConnections: 5 }, async ({ port }) => {
    // Anything but /tunnel is not a tunnel, whatever else it looks like.
    const wrongPath = await new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      ws.on('open', () => resolve({ ok: true }));
      ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on('error', () => resolve({ ok: false }));
    });
    assert.equal(wrongPath.ok, false);
    assert.equal(wrongPath.status, 403);

    // A request carrying Origin came from a browser, not from the connector, so it
    // must not be able to open a tunnel even when the pool has room.
    const withOrigin = await new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { origin: 'https://evil.example' });
      ws.on('open', () => resolve({ ok: true }));
      ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on('error', () => resolve({ ok: false }));
    });
    assert.equal(withOrigin.ok, false);
    assert.equal(withOrigin.status, 403);
  });
});

// The deploy gate calls createTunnelServer so that a bad limit fails the deploy
// instead of the restart. That only works if the constructor is where the value is
// validated, and if constructing does not itself open a listener.
test('constructing a server validates the limit without binding a port', async () => {
  assert.throws(() => createTunnelServer({ maxConnections: '0' }), /between 1 and 4096/);
  assert.throws(() => createTunnelServer({ maxConnections: 'abc' }), /between 1 and 4096/);

  const built = createTunnelServer({ maxConnections: undefined });
  assert.equal(built.limit, DEFAULT_TUNNEL_MAX_CONNECTIONS);
  assert.equal(built.server.listening, false, 'constructing must not listen');
  built.wss.close();
  built.server.close();
});

// The deploy gate imports this module as the service user to prove the tree is
// loadable before it restarts the adapter. That probe is only safe while importing
// has no side effect: if the entry guard ever becomes true under `node -e`, the
// probe would try to bind the port the running adapter already holds, and the
// failure would surface as a red deploy against a healthy host. Pin the guard.
test('importing the module does not start a listener', async () => {
  const { spawn } = await import('node:child_process');
  const probePort = 24571;
  const child = spawn(process.execPath, [
    '-e',
    `import(${JSON.stringify(new URL('../src/ws-gateway.mjs', import.meta.url).href)})`
      + `.then(() => setTimeout(() => process.exit(0), 1500))`,
  ], { env: { ...process.env, PORT: String(probePort), SSH_PORT: '1' }, stdio: 'ignore' });

  // Probe while the child is still alive: once it exits, the port would be free
  // even if the guard had fired and bound it.
  let listening = false;
  for (let i = 0; i < 10 && !listening; i++) {
    await new Promise(r => setTimeout(r, 100));
    listening = await new Promise(resolve => {
      const probe = net.connect({ host: '127.0.0.1', port: probePort });
      probe.on('connect', () => { probe.destroy(); resolve(true); });
      probe.on('error', () => resolve(false));
    });
  }
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, 'importing the module must exit cleanly');
  assert.equal(listening, false, 'import must not bind a port');
});
