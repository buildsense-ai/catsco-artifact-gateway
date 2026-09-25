import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ViewerStore, pseudonym, COOKIE_NAME, VIEWER_CONTRACT } from '../src/viewer-store.mjs';
import { createControlPlane, createStatusProbe, buildAppList, matchBySuffix, safeNext, handshakeTarget, DEFAULT_HANDSHAKE_URL } from '../src/control-plane.mjs';
import { renderGateway } from '../src/gateway-config.mjs';

const CONTROL_TOKEN = 'test-control-token-0123456789abcdef';
const CONFIG = {
  sshPort: 22443,
  user: 'cag_ingress',
  publicHosts: ['artifact.example.cc', 'artifact.example.cn'],
  hostKey: '/etc/cag/key',
  authorizedKeys: '/etc/cag/keys',
  controlPort: 22445,
  apps: [
    { id: 'demo', remotePort: 28191, publicKey: 'ssh-ed25519 AAAATEST demo', title: '演示应用' },
    { id: 'other', remotePort: 28192, publicKey: 'ssh-ed25519 AAAATEST2 other' },
  ],
};

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-test-'));
  return path.join(dir, 'viewer-state.json');
}

async function withServer(fn, options = {}) {
  // The options are read key by key instead of being spread: the registration
  // tests hand over a helper object that also carries `file` (the gateway config
  // they assert on), and a spread would make the viewer store write its state
  // into that very file.
  const { config, configPath, transportUrl, remotePortBase, remotePortCeiling, handshakeUrl, handshakeUrls, platformIdentityUrl, platformCookieName, platformIdentityTimeoutMs, fetchImpl, statusProbe } = options;
  const store = new ViewerStore({ file: tmpState() });
  const server = createControlPlane({
    config: config || CONFIG,
    store,
    controlToken: CONTROL_TOKEN,
    cookieSecure: false,
    corsOrigins: ['https://app.example.cc'],
    configPath,
    transportUrl,
    remotePortBase,
    remotePortCeiling,
    handshakeUrl,
    handshakeUrls,
    platformIdentityUrl,
    platformCookieName,
    platformIdentityTimeoutMs,
    // Default to a fetcher that refuses, so no test can silently reach the real
    // platform; the platform tests inject a loopback one.
    fetchImpl: fetchImpl || (() => { throw new Error('unexpected platform call'); }),
    // Same rule for reachability: the configured test ports are not listening, so
    // a real probe would make every list assertion depend on the machine it runs
    // on. The default reports "nothing is listening", and the probe tests inject
    // their own.
    statusProbe: statusProbe || { probeAll: async apps => new Map(apps.map(app => [app.id, 'offline'])) },
    logger: { error() {} },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ base, store }); } finally { await new Promise(resolve => server.close(resolve)); }
}

async function issue(base, body) {
  const res = await fetch(`${base}/_gateway/codes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CONTROL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('viewer id is stable per application and not correlatable across applications', () => {
  const secret = Buffer.alloc(32, 7);
  const a = pseudonym(secret, 'demo', '441');
  assert.equal(a, pseudonym(secret, 'demo', '441'));
  assert.notEqual(a, pseudonym(secret, 'other', '441'));
  assert.ok(a.startsWith('ap_'));
  assert.ok(!a.includes('441'));
  assert.throws(() => pseudonym(secret, 'demo', ''));
  assert.throws(() => pseudonym(Buffer.alloc(8), 'demo', '1'));
});

test('codes are single use and expire', () => {
  let now = 1_700_000_000_000;
  const store = new ViewerStore({ file: tmpState(), codeTtlSeconds: 60, sessionTtlSeconds: 100, now: () => now });
  const { code } = store.issueCode({ app: 'demo', uid: 'u1', topic: 't1' });
  assert.equal(store.redeemCode(code, { app: 'other' }), null, 'code must not be usable for another application');
  const first = store.redeemCode(code);
  assert.ok(first);
  assert.equal(store.redeemCode(code), null, 'code is one time');
  assert.ok(store.resolve(first.token, { app: 'demo' }));
  assert.equal(store.resolve(first.token, { app: 'other' }), null, 'session is application scoped');
  now += 200_000;
  assert.equal(store.resolve(first.token, { app: 'demo' }), null, 'session expires');
});

test('expired code is rejected', () => {
  let now = 1_700_000_000_000;
  const store = new ViewerStore({ file: tmpState(), codeTtlSeconds: 60, now: () => now });
  const { code } = store.issueCode({ app: 'demo', uid: 'u1' });
  now += 61_000;
  assert.equal(store.redeemCode(code), null);
});

test('state survives a restart and the pseudonym secret is not rotated', () => {
  const file = tmpState();
  const first = new ViewerStore({ file });
  const session = first.redeemCode(first.issueCode({ app: 'demo', uid: 'u1' }).code);
  const subject = session.record.sub;
  const second = new ViewerStore({ file });
  assert.ok(second.resolve(session.token, { app: 'demo' }));
  assert.equal(second.pseudonymFor('demo', 'u1'), subject);
});

test('public list exposes only id, title, url, status and time', () => {
  // Without probes the list still answers, and says so honestly: 'unknown'
  // rather than a claim that every application is reachable.
  const apps = buildAppList(CONFIG, { updatedAt: '2026-09-17T00:00:00.000Z' });
  assert.deepEqual(apps, [
    { id: 'demo', title: '演示应用', url: 'https://artifact.example.cc/demo/', status: 'unknown', updated_at: '2026-09-17T00:00:00.000Z' },
    { id: 'other', title: 'other', url: 'https://artifact.example.cc/other/', status: 'unknown', updated_at: '2026-09-17T00:00:00.000Z' },
  ]);
  // A probe result is reported per application, and an application the probe did
  // not cover stays 'unknown' instead of inheriting a neighbour's answer.
  const probed = buildAppList(CONFIG, { statuses: new Map([['demo', 'online']]) });
  assert.equal(probed[0].status, 'online');
  assert.equal(probed[1].status, 'unknown');
});

// The list used to answer a constant 'ready', so a stopped application and a
// healthy one looked the same. These two checks separate the cases the sidebar
// could not previously tell apart, using the tunnel's own forwarding socket.
test('a listening application is reported online even when it answers an error', async () => {
  // 401 is the ordinary answer of an application that wants a login: it proves
  // the local end is up, which is all the probe claims to know.
  const app = http.createServer((req, res) => { res.writeHead(401); res.end('no'); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const probe = createStatusProbe();
    const statuses = await probe.probeAll([{ id: 'demo', remotePort: app.address().port }]);
    assert.equal(statuses.get('demo'), 'online');
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('a port with nothing behind it is reported offline', async () => {
  // Bind and release, so the port is free and therefore refuses connections —
  // the shape of a tunnel that is up while its application is not, and of a
  // connector that never came back after a reboot.
  const app = http.createServer();
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port;
  await new Promise(resolve => app.close(resolve));

  const probe = createStatusProbe();
  const statuses = await probe.probeAll([{ id: 'demo', remotePort: port }]);
  assert.equal(statuses.get('demo'), 'offline');
});

test('the probe caches, so a refresh burst costs one round of probes', async () => {
  let calls = 0;
  const probe = createStatusProbe({ probe: async () => { calls += 1; return 'online'; }, cacheMs: 60_000 });
  const apps = [{ id: 'demo', remotePort: 28191 }, { id: 'other', remotePort: 28192 }];
  const first = await probe.probeAll(apps);
  assert.equal(calls, 2);
  const second = await probe.probeAll(apps);
  assert.equal(calls, 2, 'a second call inside the window must not probe again');
  assert.equal(second.get('demo'), 'online');
  assert.deepEqual([...first.keys()].sort(), ['demo', 'other']);

  // A changed set of applications must not reuse the cached answers: a new
  // application has never been probed, and a removed one must not linger. The
  // whole set is re-probed rather than patched, so no entry can outlive its
  // application.
  await probe.probeAll([...apps, { id: 'third', remotePort: 28193 }]);
  assert.equal(calls, 5, 'a changed set must be probed again in full');
});

test('the list reports a probe failure as offline rather than failing the request', async () => {
  await withServer(async ({ base }) => {
    const listed = await (await fetch(`${base}/api/apps`)).json();
    // The injected default probe reports offline; the important part is that the
    // request answered 200 with a status per application instead of erroring.
    assert.equal(listed.apps.length, CONFIG.apps.length);
    for (const app of listed.apps) assert.equal(app.status, 'offline');
  });
});

test('list endpoint answers the sidebar and ignores unknown origins', async () => {
  await withServer(async ({ base }) => {
    const allowed = await fetch(`${base}/api/apps`, { headers: { Origin: 'https://app.example.cc' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.cc');
    const body = await allowed.json();
    assert.equal(body.apps.length, 2);
    assert.equal(body.apps[0].url, 'https://artifact.example.cc/demo/');
    const stranger = await fetch(`${base}/api/apps`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  });
});

test('code issuance requires the control token and a known application', async () => {
  await withServer(async ({ base }) => {
    const unauthorized = await fetch(`${base}/_gateway/codes`, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    const wrongToken = await fetch(`${base}/_gateway/codes`, { method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(33)}` }, body: JSON.stringify({ app: 'demo', uid: 'u1' }) });
    assert.equal(wrongToken.status, 401);
    const unknown = await issue(base, { app: 'ghost', uid: 'u1' });
    assert.equal(unknown.status, 404);
    const ok = await issue(base, { app: 'demo', uid: 'u1', topic: 'topic-1' });
    assert.equal(ok.status, 201);
    assert.match(ok.body.launch_url, /^http?s:\/\/artifact\.example\.cc\/_launch\/[A-Za-z0-9_-]{32,}\?next=\/demo\/$/);
  });
});

test('top-level entry redeems into an HttpOnly session cookie and lands on the clean URL', async () => {
  await withServer(async ({ base }) => {
    const { body } = await issue(base, { app: 'demo', uid: 'u1', topic: 'topic-1' });
    const res = await fetch(body.launch_url.replace('https://artifact.example.cc', base), { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/demo/');
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
    for (const attr of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=']) assert.ok(cookie.includes(attr), attr);
    const replay = await fetch(body.launch_url.replace('https://artifact.example.cc', base), { redirect: 'manual' });
    assert.equal(replay.status, 410, 'code cannot be redeemed twice');
  });
});

test('identity endpoint returns the same shape for cookie and bearer, guest without credential', async () => {
  await withServer(async ({ base }) => {
    const guest = await (await fetch(`${base}/_gateway/me?app=demo`)).json();
    assert.deepEqual(guest, { contract: VIEWER_CONTRACT, authenticated: false, viewer: null, app_id: 'demo', topic_id: null, expires_at: null });

    const { body } = await issue(base, { app: 'demo', uid: 'u1', topic: 'topic-1' });
    const json2 = await (await fetch(`${base}/_launch/${body.code}?format=json`)).json();
    assert.equal(json2.app_id, 'demo');

    const viaBearer = await fetch(`${base}/_gateway/me?app=demo`, { headers: { Authorization: `Bearer ${json2.token}` } });
    const viaCookie = await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: `${COOKIE_NAME}=${json2.token}` } });
    const bearerViewer = await viaBearer.json();
    const cookieViewer = await viaCookie.json();
    assert.deepEqual(bearerViewer, cookieViewer);
    const viewer = cookieViewer;
    assert.equal(viewer.authenticated, true);
    assert.equal(viewer.app_id, 'demo');
    assert.equal(viewer.topic_id, 'topic-1');
    assert.match(viewer.viewer.id, /^ap_[A-Za-z0-9_-]{22}$/);
    assert.equal(viewer.viewer.kind, 'user');
  });
});

test('a session minted for one application is refused for another sharing the origin', async () => {
  await withServer(async ({ base }) => {
    const { body } = await issue(base, { app: 'demo', uid: 'u1' });
    const token = (await (await fetch(`${base}/_launch/${body.code}?format=json`)).json()).token;
    const cross = await fetch(`${base}/_gateway/me?app=other`, { headers: { Cookie: `${COOKIE_NAME}=${token}` } });
    assert.equal(cross.status, 401);
    const forged = await fetch(`${base}/_gateway/me?app=other`, { headers: { Cookie: `${COOKIE_NAME}=${'a'.repeat(43)}` } });
    assert.equal(forged.status, 401);
    const unknownApp = await fetch(`${base}/_gateway/me?app=ghost`);
    assert.equal(unknownApp.status, 404);
  });
});

// The session cookie carries one application, but the browser holds one value
// per gateway host: after visiting another application on the same origin, the
// visitor presents a record this application cannot use. The platform domain
// cookie still speaks for them, so that must not be answered as an error.
test('an unusable session cookie still lets the platform cookie identify the visitor', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 363, expires_at: PLATFORM_EXPIRES }));
  try {
    await withServer(async ({ base, store }) => {
      const foreign = await issueToken(base, 'u1'); // minted for `demo`
      const res = await fetch(`${base}/_gateway/me?app=other`, {
        headers: { Cookie: `${COOKIE_NAME}=${foreign}; ${PLATFORM_COOKIE}` },
      });
      assert.equal(res.status, 200, 'a session for another application is not a failed request');
      const viewer = await res.json();
      assert.equal(viewer.authenticated, true);
      assert.equal(viewer.app_id, 'other');
      assert.equal(viewer.topic_id, null, 'the platform path carries no session context');
      assert.equal(viewer.viewer.uid, 363);
      assert.equal(viewer.viewer.id, store.pseudonymFor('other', '363'));
      assert.equal(platform.calls(), 1);
      assert.equal(platform.seen[0].cookie, PLATFORM_COOKIE, 'the platform is asked about the domain cookie');

      // Nothing vouches for the visitor: the present-but-unusable credential is
      // still reported, so an application can re-launch instead of degrading.
      const bare = await fetch(`${base}/_gateway/me?app=other`, { headers: { Cookie: `${COOKIE_NAME}=${foreign}` } });
      assert.equal(bare.status, 401);
      assert.equal(platform.calls(), 1, 'a request without a platform cookie must not reach the platform');
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('identity resolves the application from the referring path', async () => {
  await withServer(async ({ base }) => {
    const { body } = await issue(base, { app: 'demo', uid: 'u7', topic: 't-9' });
    const token = (await (await fetch(`${base}/_launch/${body.code}?format=json`)).json()).token;
    const res = await fetch(`${base}/_gateway/me`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}`, Referer: 'https://artifact.example.cc/demo/index.html' },
    });
    const viewer = await res.json();
    assert.equal(viewer.app_id, 'demo');
    assert.equal(viewer.topic_id, 't-9');
  });
});

test('an application is only listed for the bot that owns it', () => {
  const owned = {
    ...CONFIG,
    apps: [
      { ...CONFIG.apps[0], agent: '365' },
      { ...CONFIG.apps[1], agent: '9308' },
      { id: 'unowned', remotePort: 28193, publicKey: 'ssh-ed25519 AAAATEST3 unowned' },
    ],
  };
  const ids = (agent) => buildAppList(owned, agent === undefined ? {} : { agent }).map(app => app.id);
  assert.deepEqual(ids('365'), ['demo']);
  assert.deepEqual(ids('9308'), ['other']);
  assert.deepEqual(ids('999'), [], 'a bot with no registered application sees nothing');
  assert.ok(!ids('365').includes('unowned'), 'an application with no declared owner belongs to no bot');
  assert.deepEqual(ids(), ['demo', 'other', 'unowned'], 'an unscoped caller still sees the inventory');
});

test('the list endpoint scopes to the requested bot', async () => {
  const store = new ViewerStore({ file: tmpState() });
  const server = createControlPlane({
    config: { ...CONFIG, apps: [{ ...CONFIG.apps[0], agent: '365' }, { ...CONFIG.apps[1], agent: '9308' }] },
    store,
    controlToken: CONTROL_TOKEN,
    logger: { error() {} },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const scoped = await (await fetch(`${base}/api/apps?agent=365`)).json();
    assert.deepEqual(scoped.apps.map(app => app.id), ['demo']);
    const empty = await (await fetch(`${base}/api/apps?agent=777`)).json();
    assert.deepEqual(empty.apps, []);
    const all = await (await fetch(`${base}/api/apps`)).json();
    assert.equal(all.apps.length, 2);
    assert.equal((await fetch(`${base}/api/apps?agent=bot`)).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('gateway exposes the control plane and lets applications read their own cookie', () => {
  const r = renderGateway(CONFIG);
  assert.ok(r.locations.includes('location = /_gateway/tunnel'));
  assert.ok(r.locations.includes('location = /_gateway/me'));
  assert.ok(r.locations.includes('location = /_gateway/codes'));
  // Publishing is a platform-to-gateway call, so this route has to be reachable
  // from outside the host like `/_gateway/codes` is.
  assert.ok(r.locations.includes('location ^~ /_gateway/apps'));
  assert.ok(r.locations.includes('location ^~ /_launch/'));
  assert.ok(r.locations.includes('location = /api/apps'));
  assert.ok(r.locations.includes('proxy_pass http://127.0.0.1:22445'));
  const appBlock = r.locations.split('location ^~ /demo/')[1];
  assert.ok(!appBlock.includes('proxy_set_header Cookie ""'), 'application path must receive the viewer cookie');
  assert.ok(!appBlock.includes('proxy_hide_header Set-Cookie'), 'application path may set its own cookies');
  assert.ok(r.locations.includes('proxy_set_header Cookie ""'), 'tunnel and control-plane ingress still strip cookies');
  // The control plane picks a public domain and a handshake page by the request
  // Host. Without the forward, nginx sends its own upstream address and every
  // lookup silently falls back to the first domain, so a `.cn` visitor would be
  // sent to the `.cc` login page.
  const controlBlock = r.locations.split('location ^~ /demo/')[0];
  const toControl = controlBlock.match(/proxy_pass http:\/\/127\.0\.0\.1:22445;/g) || [];
  const forwarded = controlBlock.match(/proxy_pass http:\/\/127\.0\.0\.1:22445; proxy_set_header Host \$host;/g) || [];
  assert.equal(toControl.length, 7, 'expected the seven shared control routes');
  assert.equal(forwarded.length, toControl.length, 'every control route must forward the browser Host');
  assert.ok(!renderGateway({ ...CONFIG, controlPort: undefined }).locations.includes('/_gateway/me'), 'control routes are optional');
  for (const controlPort of [80, '22445', 0]) assert.throws(() => renderGateway({ ...CONFIG, controlPort }));
  assert.throws(() => renderGateway({ ...CONFIG, controlPort: 28191 }), 'control port must not collide with an application');
});

test('return paths stay inside the requesting application', () => {
  assert.equal(safeNext('/demo/page.html', 'demo'), '/demo/page.html');
  assert.equal(safeNext('/demo/', 'demo'), '/demo/');
  for (const hostile of [
    'https://evil.example/',
    '//evil.example/',
    '/other/',
    '/demo/../../etc',
    '/demo/x\\y',
    null,
    '',
    'x'.repeat(600),
  ]) assert.equal(safeNext(hostile, 'demo'), '/demo/', `must be rejected: ${hostile}`);
});

test('the default handshake page is the file the platform actually serves', () => {
  // The platform's single-page app owns every extension-less path, so a bare
  // `/artifact-auth` renders the app itself and the exchange silently becomes a
  // no-op. This guard keeps the default on the real file, and keeps the
  // validator able to accept it.
  assert.equal(DEFAULT_HANDSHAKE_URL, 'https://app.catsco.cc/artifact-auth.html');
  const target = new URL(handshakeTarget(DEFAULT_HANDSHAKE_URL, 'demo', '/demo/', 'https://artifact.catsco.cc'));
  assert.equal(target.pathname, '/artifact-auth.html');
});

test('handshake target carries the application, the return path and the gateway origin', () => {
  const target = new URL(handshakeTarget('https://app.example.cc/artifact-auth', 'demo', '/demo/page.html', 'https://artifact.example.cn'));
  assert.equal(target.origin, 'https://app.example.cc');
  assert.equal(target.pathname, '/artifact-auth');
  assert.equal(target.searchParams.get('app'), 'demo');
  assert.equal(target.searchParams.get('next'), '/demo/page.html');
  assert.equal(target.searchParams.get('gw'), 'https://artifact.example.cn');
});

test('an application without a credential is sent to the platform handshake', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/_auth/start?app=demo&next=%2Fdemo%2Findex.html`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin, 'https://app.catsco.cc');
    assert.equal(location.pathname, '/artifact-auth.html');
    assert.equal(location.searchParams.get('app'), 'demo');
    assert.equal(location.searchParams.get('next'), '/demo/index.html');

    const hostile = await fetch(`${base}/_auth/start?app=demo&next=https%3A%2F%2Fevil.example%2F`, { redirect: 'manual' });
    assert.equal(new URL(hostile.headers.get('location')).searchParams.get('next'), '/demo/', 'open redirect must not survive');

    const unknown = await fetch(`${base}/_auth/start?app=ghost`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);

    const wrongMethod = await fetch(`${base}/_auth/start?app=demo`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
  });
});

test('a failed handshake offers login or guest instead of silently continuing', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/_auth/declined?app=demo&next=%2Fdemo%2F`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('/_auth/start?app=demo'));
    assert.ok(html.includes('identity=guest'));
    assert.ok(html.includes('/demo/'));
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await fetch(`${base}/_auth/declined?app=ghost`)).status, 404);
  });
});

test('the rendered gateway routes the auth handshake to the control plane', () => {
  assert.ok(renderGateway(CONFIG).locations.includes('location ^~ /_auth/'));
  assert.ok(!renderGateway({ ...CONFIG, controlPort: undefined }).locations.includes('/_auth/'));
});

// --- Platform domain cookie relay -------------------------------------------
//
// The platform sets `catsco_artifact_id` with Domain=.catsco.cc, so the browser
// also sends it to the application host. These tests stand in for the platform
// endpoint with a loopback server: the gateway is handed a normal https URL and
// an injected fetcher re-points it at the stub, so the production URL rule stays
// exactly as configured while the outbound request is still counted and read.

const PLATFORM_COOKIE = 'catsco_artifact_id=363.1758260000.sig';
const PLATFORM_EXPIRES = '2026-09-19T12:00:00.000Z';
const GUEST = { contract: VIEWER_CONTRACT, authenticated: false, viewer: null, app_id: 'demo', topic_id: null, expires_at: null };

function platformBody(body, status = 200) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

async function platformStub(handler = platformBody({})) {
  const seen = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    seen.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stub = {
    url: 'https://platform-identity.test/api/artifacts/identity',
    seen,
    calls: () => calls,
    attempts: 0,
    fetch: (uri, init) => { stub.attempts += 1; return fetch(origin + new URL(uri).pathname, init); },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
  return stub;
}

function issueToken(base, uid) {
  return issue(base, { app: 'demo', uid }).then(({ body }) => fetch(`${base}/_launch/${body.code}?format=json`).then(r => r.json()).then(r => r.token));
}

test('a gateway session answers /_gateway/me without asking the platform', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 363 }));
  try {
    await withServer(async ({ base }) => {
      const token = await issueToken(base, 'u1');
      const res = await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: `${COOKIE_NAME}=${token}; ${PLATFORM_COOKIE}` } });
      const viewer = await res.json();
      assert.equal(viewer.authenticated, true);
      assert.equal(viewer.topic_id, null, 'the session record still wins, it carries the topic');
      assert.equal(platform.attempts, 0, 'a gateway session must not cost a platform round trip');
      assert.equal(platform.calls(), 0);
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('a platform domain cookie identifies the viewer without a launch code', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 363, expires_at: PLATFORM_EXPIRES }));
  try {
    await withServer(async ({ base, store }) => {
      const res = await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } });
      assert.equal(res.status, 200);
      const viewer = await res.json();
      assert.equal(viewer.contract, VIEWER_CONTRACT);
      assert.equal(viewer.authenticated, true);
      assert.equal(viewer.app_id, 'demo');
      assert.equal(viewer.topic_id, null, 'a domain cookie carries no session context');
      assert.equal(viewer.expires_at, PLATFORM_EXPIRES);
      assert.equal(viewer.viewer.kind, 'user');
      assert.match(viewer.viewer.id, /^ap_[A-Za-z0-9_-]{22}$/);
      assert.equal(viewer.viewer.id, store.pseudonymFor('demo', '363'), 'the relay reuses the one-shot pseudonym');

      const codeToken = await issueToken(base, 363);
      const viaCode = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: `${COOKIE_NAME}=${codeToken}` } })).json();
      assert.equal(viaCode.viewer.id, viewer.viewer.id, 'both entries must land on the same viewer id');

      const other = await (await fetch(`${base}/_gateway/me?app=other`, { headers: { Cookie: PLATFORM_COOKIE } })).json();
      assert.notEqual(other.viewer.id, viewer.viewer.id, 'the pseudonym stays application scoped');

      assert.equal(platform.attempts, 2, 'one check per platform-cookie request, none for the code path');
      assert.deepEqual(platform.seen[0], { url: '/api/artifacts/identity', cookie: PLATFORM_COOKIE, authorization: `Bearer ${CONTROL_TOKEN}` });
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('a platform cookie the platform will not confirm degrades to guest', async () => {
  const rejecting = await platformStub(platformBody({ error: 'unauthorized' }, 401));
  const denying = await platformStub(platformBody({ authenticated: false }));
  const garbage = await platformStub((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('not json'); });
  const hanging = await platformStub(() => { /* never answers */ });
  const dead = await platformStub();
  const deadUrl = dead.url;
  const deadFetch = dead.fetch;
  await dead.close();
  try {
    for (const [label, stub, options] of [
      ['401', rejecting, {}],
      ['authenticated false', denying, {}],
      ['unreadable body', garbage, {}],
      ['network error', null, { platformIdentityUrl: deadUrl, fetchImpl: deadFetch }],
      ['timeout', hanging, { platformIdentityTimeoutMs: 120 }],
    ]) {
      await assert.doesNotReject(async () => {
        await withServer(async ({ base }) => {
          const res = await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } });
          assert.equal(res.status, 200, `${label} must not fail the request`);
          assert.deepEqual(await res.json(), GUEST, `${label} must fall back to guest`);
        }, { platformIdentityUrl: stub ? stub.url : options.platformIdentityUrl, fetchImpl: stub ? stub.fetch : options.fetchImpl, ...options });
      });
    }
    assert.equal(dead.calls(), 0);
  } finally {
    for (const stub of [rejecting, denying, garbage, hanging]) await stub.close();
  }
});

test('a visitor without the platform cookie is never sent to the platform', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 363 }));
  try {
    await withServer(async ({ base }) => {
      const res = await fetch(`${base}/_gateway/me?app=demo`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), GUEST);
      assert.equal(platform.attempts, 0, 'a real guest must not cost a network round trip');
      assert.equal(platform.calls(), 0);
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('an empty platform identity URL switches the relay off', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 363 }));
  try {
    await withServer(async ({ base }) => {
      const res = await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), GUEST);
      assert.equal(platform.attempts, 0);
    }, { platformIdentityUrl: '', fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('the platform cookie name is configurable and both settings are validated', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 363, expires_at: PLATFORM_EXPIRES }));
  try {
    await withServer(async ({ base }) => {
      const renamed = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: 'catsco_alt=363.1758260000.sig' } })).json();
      assert.equal(renamed.authenticated, true);
      const ignored = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } })).json();
      assert.deepEqual(ignored, GUEST, 'the default name is no longer read');
    }, { platformIdentityUrl: platform.url, platformCookieName: 'catsco_alt', fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }

  const plain = { config: CONFIG, store: new ViewerStore({ file: tmpState() }), controlToken: CONTROL_TOKEN };
  for (const platformCookieName of ['', 'a b', 'a=b', '__Host-aid\n', 'x'.repeat(65), 42, null]) {
    assert.throws(() => createControlPlane({ ...plain, platformCookieName }), `cookie name must be rejected: ${platformCookieName}`);
  }
  for (const platformIdentityUrl of ['http://app.catsco.cc/api/artifacts/identity', 'https://', 'https://app.catsco.cc', 'https://app.catsco.cc/x?y=1', 'https://app.catsco.cc/%2e%2e/x', 42]) {
    assert.throws(() => createControlPlane({ ...plain, platformIdentityUrl }), `identity URL must be rejected: ${platformIdentityUrl}`);
  }
  assert.ok(createControlPlane({ ...plain, platformIdentityUrl: '' }), 'an empty URL is the documented off switch');
});

// --- One site per visitor ----------------------------------------------------
//
// The platform and the gateway each answer on two registrable domains. A visitor
// signed in on one of them must be handed a URL on the same one, because the
// cookies that carry the identity are Lax and scoped to that site. Getting this
// wrong does not fail loudly: the other domain serves the very same application
// and simply shows the visitor as a guest.

// fetch() will not let a test choose the Host header, and the Host is exactly
// what this decision reads, so this one request is made with the raw client.
function requestWithHost(base, path, host) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Host: host } }, res => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', reject);
    req.end();
  });
}

test('the launch URL stays on the domain the caller is signed in to', () => {
  const hosts = CONFIG.publicHosts;
  assert.equal(matchBySuffix(hosts, 'app.example.cc'), 'artifact.example.cc');
  assert.equal(matchBySuffix(hosts, 'app.example.cn'), 'artifact.example.cn');
  assert.equal(matchBySuffix(hosts, 'app.example.cn:8443'), 'artifact.example.cn', 'a port is not part of the site');
  assert.equal(matchBySuffix(hosts, 'APP.EXAMPLE.CN'), 'artifact.example.cn', 'hostnames are case insensitive');
  // A hint that names no configured site falls back to the first host. An older
  // platform sends no hint at all, and the fallback must never echo the hint
  // back: that would let the caller choose the domain.
  for (const hint of ['', undefined, null, 'evil.example', 'app.example.com', 'app.catsco.cn', 'not a host', '127.0.0.1', 'x'.repeat(300)]) {
    assert.equal(matchBySuffix(hosts, hint), 'artifact.example.cc', `unexpected choice for ${JSON.stringify(hint)}`);
  }
  assert.equal(matchBySuffix([], 'app.example.cn'), null);
});

test('code issuance puts the launch URL on the caller own domain', async () => {
  await withServer(async ({ base }) => {
    const cn = await issue(base, { app: 'demo', uid: '441', host: 'app.example.cn' });
    assert.equal(cn.status, 201);
    assert.match(cn.body.launch_url, /^https:\/\/artifact\.example\.cn\/_launch\/[A-Za-z0-9_-]{32,}\?next=\/demo\/$/);

    const cc = await issue(base, { app: 'demo', uid: '441', host: 'app.example.cc' });
    assert.match(cc.body.launch_url, /^https:\/\/artifact\.example\.cc\/_launch\//);

    const noHint = await issue(base, { app: 'demo', uid: '441' });
    assert.match(noHint.body.launch_url, /^https:\/\/artifact\.example\.cc\/_launch\//, 'the first host stays the default');

    const hostile = await issue(base, { app: 'demo', uid: '441', host: 'evil.example' });
    assert.match(hostile.body.launch_url, /^https:\/\/artifact\.example\.cc\/_launch\//, 'a hint can only select a configured host');
  });
});

test('the handshake page follows the domain the browser is on', async () => {
  const handshakeUrls = ['https://app.example.cc/artifact-auth.html', 'https://app.example.cn/artifact-auth.html'];
  await withServer(async ({ base }) => {
    const at = async host => new URL((await requestWithHost(base, '/_auth/start?app=demo', host)).location);
    assert.equal((await at('artifact.example.cn')).origin, 'https://app.example.cn');
    assert.equal((await at('artifact.example.cc')).origin, 'https://app.example.cc');
    assert.equal((await at('unknown.example.com')).origin, 'https://app.example.cc', 'an unknown host gets the default page');
    assert.equal((await at('artifact.example.cn')).searchParams.get('gw'), 'https://artifact.example.cn', 'the exchange returns to the same gateway domain');
  }, { handshakeUrls });
});

// --- Identity fields ---------------------------------------------------------

test('both entry paths publish the platform uid and the account name', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 441, username: 'john.doe', expires_at: PLATFORM_EXPIRES }));
  try {
    await withServer(async ({ base }) => {
      const silent = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } })).json();
      assert.equal(silent.viewer.uid, 441);
      assert.equal(silent.viewer.username, 'john.doe');

      const { body } = await issue(base, { app: 'demo', uid: '441', username: 'john.doe', topic: 't1' });
      const token = (await (await fetch(`${base}/_launch/${body.code}?format=json`)).json()).token;
      const coded = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: `${COOKIE_NAME}=${token}` } })).json();
      assert.equal(coded.viewer.uid, 441);
      assert.equal(coded.viewer.username, 'john.doe');
      assert.equal(coded.viewer.id, silent.viewer.id, 'both entries still agree on the pseudonym');
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('a missing or non-numeric identity publishes null instead of a guess', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 441, expires_at: PLATFORM_EXPIRES }));
  try {
    await withServer(async ({ base }) => {
      const silent = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } })).json();
      assert.ok('username' in silent.viewer, 'the field is part of the shape, not optional by omission');
      assert.equal(silent.viewer.username, null, 'a platform that sends no name must not break the exchange');
      assert.equal(silent.viewer.uid, 441);

      const { body } = await issue(base, { app: 'demo', uid: 'u1', username: 'saturday' });
      const token = (await (await fetch(`${base}/_launch/${body.code}?format=json`)).json()).token;
      const viewer = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: `${COOKIE_NAME}=${token}` } })).json();
      assert.equal(viewer.viewer.uid, null, 'a subject that is not a number publishes null');
      assert.equal(viewer.viewer.username, 'saturday');
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('a platform uid of the wrong shape is refused, not minted into a viewer', async () => {
  const platform = await platformStub(platformBody({ authenticated: true, uid: 'u1', expires_at: PLATFORM_EXPIRES }));
  try {
    await withServer(async ({ base }) => {
      const viewer = await (await fetch(`${base}/_gateway/me?app=demo`, { headers: { Cookie: PLATFORM_COOKIE } })).json();
      assert.deepEqual(viewer, GUEST, 'the platform is the only authority on the shape of its own uid');
    }, { platformIdentityUrl: platform.url, fetchImpl: platform.fetch });
  } finally {
    await platform.close();
  }
});

test('a session minted before the account name existed still answers', () => {
  const store = new ViewerStore({ file: tmpState(), now: () => 1_700_000_000_000 });
  const session = store.redeemCode(store.issueCode({ app: 'demo', uid: '441' }).code);
  // A record written by the previous release carries only the pseudonym.
  delete store.state.sessions[session.token].uid;
  delete store.state.sessions[session.token].username;
  const viewer = store.viewerRecord(session.token, 'demo');
  assert.equal(viewer.authenticated, true);
  assert.match(viewer.viewer.id, /^ap_[A-Za-z0-9_-]{22}$/);
  assert.equal(viewer.viewer.uid, null);
  assert.equal(viewer.viewer.username, null);
  assert.equal(viewer.topic_id, null);
});

test('a handshake list is validated like every other outbound URL', () => {
  const plain = { config: CONFIG, store: new ViewerStore({ file: tmpState() }), controlToken: CONTROL_TOKEN };
  for (const handshakeUrls of [['http://app.example.cc/artifact-auth.html'], ['https://app.example.cc'], ['https://app.example.cc/x?y=1'], [42]]) {
    assert.throws(() => createControlPlane({ ...plain, handshakeUrls }), `handshake list must be rejected: ${handshakeUrls}`);
  }
  assert.ok(createControlPlane({ ...plain, handshakeUrls: [] }), 'an empty list falls back to the single handshake URL');
});

// --- Application registration ------------------------------------------------
//
// Publishing used to be an edit to the gateway host's own config file by whoever
// owned that machine. These tests drive the interface that replaces it: a
// control-token call that picks the port, persists the application and makes it
// visible everywhere at once. Every test that writes runs against a real config
// file, because re-reading that file is the whole mechanism.

// A fresh copy per test: a registration must not leak into the next test's port
// space, and the assertions compare the file before and after a refusal.
function registrationConfig(extraApps = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-config-'));
  const file = path.join(dir, 'gateway.json');
  const content = { ...CONFIG, apps: [...CONFIG.apps.map(app => ({ ...app })), ...extraApps] };
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n', { mode: 0o600 });
  return { file, content, configPath: file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function registration(overrides = {}) {
  return { id: 'board', title: '我的看板', agent: '365', publicKey: 'ssh-ed25519 AAAABOARD board', ...overrides };
}

async function apps(base, { method = 'GET', path = '/_gateway/apps', body, token = CONTROL_TOKEN } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('registration requires the control token for every method', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    for (const call of [
      { method: 'GET' },
      { method: 'POST', body: registration() },
      { method: 'DELETE', path: '/_gateway/apps/demo' },
    ]) {
      const anonymous = await apps(base, { ...call, token: null });
      assert.equal(anonymous.status, 401, `${call.method} must refuse an anonymous caller`);
      const wrong = await apps(base, { ...call, token: 'x'.repeat(33) });
      assert.equal(wrong.status, 401, `${call.method} must refuse a wrong token`);
    }
    assert.equal((await apps(base, { method: 'PUT' })).status, 405);
    assert.deepEqual(config.read(), config.content, 'a refused caller must not touch the config');
  }, config);
});

test('a registration is assigned a port and answers with every public URL', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    const first = await apps(base, { method: 'POST', body: registration({ localPort: 20000 }) });
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'registered');
    assert.equal(first.body.id, 'board');
    assert.equal(first.body.title, '我的看板');
    assert.equal(first.body.agent, '365');
    // The documented allocation: the first free port at or above 28201.
    assert.equal(first.body.remote_port, 28201);
    assert.deepEqual(first.body.urls, ['https://artifact.example.cc/board/', 'https://artifact.example.cn/board/']);
    assert.equal(first.body.url, first.body.urls[0], 'the single url is the first public domain');
    assert.equal(first.body.transport_url, 'wss://artifact.example.cc/_gateway/tunnel');
    assert.equal(first.body.local_port, 20000, 'the local port is echoed, not acted on');
    assert.equal(new Date(first.body.updated_at).toISOString(), first.body.updated_at);

    // The port belongs to the gateway: a caller-supplied one is ignored rather
    // than allowed to collide with a running tunnel.
    const second = await apps(base, { method: 'POST', body: registration({ id: 'second', title: 'Second', publicKey: 'ssh-ed25519 AAAASECOND second', remotePort: 28191 }) });
    assert.equal(second.status, 201);
    assert.equal(second.body.remote_port, 28202);

    const onDisk = config.read();
    assert.deepEqual(onDisk.apps.map(app => app.id), ['demo', 'other', 'board', 'second']);
    assert.deepEqual(onDisk.apps[2], { id: 'board', title: '我的看板', agent: '365', remotePort: 28201, publicKey: 'ssh-ed25519 AAAABOARD board', localPort: 20000 });
    assert.equal(fs.statSync(config.configPath).mode & 0o777, 0o600, 'the config keeps its mode');
  }, config);
});

test('an application without an owner is refused', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    const missing = await apps(base, { method: 'POST', body: registration({ agent: undefined }) });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'agent_required');
    for (const agent of ['', null, 0, '0', 'bot', -1]) {
      const res = await apps(base, { method: 'POST', body: registration({ agent }) });
      assert.equal(res.status, 400, `agent ${JSON.stringify(agent)} must be refused`);
    }
    assert.deepEqual(config.read(), config.content, 'not one refused registration may be persisted');
  }, config);
});

test('every registration passes through the renderer', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    const rejected = [
      ['malformed id', registration({ id: 'Bad Id' })],
      ['empty id', registration({ id: '' })],
      ['uppercase id', registration({ id: 'Board' })],
      ['over-long id', registration({ id: `b${'x'.repeat(48)}` })],
      ['missing key', registration({ publicKey: undefined })],
      ['non ed25519 key', registration({ publicKey: 'ssh-rsa AAAABOARD board' })],
      ['truncated key', registration({ publicKey: 'ssh-ed25519' })],
      ['key with a newline', registration({ publicKey: 'ssh-ed25519 AAAABOARD\nboard' })],
      ['key of another application', registration({ publicKey: 'ssh-ed25519 AAAATEST demo' })],
      ['over-long title', registration({ title: 'x'.repeat(61) })],
      ['unprivileged local port', registration({ localPort: 80 })],
      ['non numeric local port', registration({ localPort: '20000' })],
    ];
    for (const [label, body] of rejected) {
      const res = await apps(base, { method: 'POST', body });
      assert.equal(res.status, 400, `${label} must be refused`);
      assert.ok(res.body.message, `${label} must report the renderer's reason`);
      assert.ok(!JSON.stringify(res.body).includes('publicHosts'), 'a failure must not echo the config back');
    }
    assert.equal((await apps(base, { method: 'POST', body: 'not json' })).body.error, 'invalid_json');
    assert.equal((await apps(base, { method: 'POST', body: '[1,2]' })).status, 400);
    assert.deepEqual(config.read(), config.content, 'nothing that failed validation may be persisted');
  }, config);
});

test('re-registering an application keeps its remote port and its title', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    const first = await apps(base, { method: 'POST', body: registration() });
    const again = await apps(base, { method: 'POST', body: registration({ publicKey: 'ssh-ed25519 AAAAROTATED board', localPort: 20011 }) });
    assert.equal(again.status, 201);
    assert.equal(again.body.status, 'updated');
    assert.equal(again.body.remote_port, first.body.remote_port, 'a running tunnel must not be moved');

    const retitled = await apps(base, { method: 'POST', body: registration({ title: undefined, publicKey: 'ssh-ed25519 AAAALATER board' }) });
    assert.equal(retitled.body.title, '我的看板', 'a caller that sends no title cannot rename the sidebar entry');

    const stored = config.read().apps.filter(app => app.id === 'board');
    assert.equal(stored.length, 1, 'an update replaces the entry instead of adding one');
    assert.deepEqual(stored[0], { id: 'board', title: '我的看板', agent: '365', remotePort: first.body.remote_port, publicKey: 'ssh-ed25519 AAAALATER board', localPort: 20011 });
  }, config);
});

test('an application cannot be taken over by re-registering its id', async () => {
  // An update replaces the entry by id, so a caller that skipped its own
  // ownership check could otherwise move another account's application — and the
  // public key, and the port its connector forwards — onto itself.
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    const mine = await apps(base, { method: 'POST', body: registration({ id: 'taken', agent: '365', publicKey: 'ssh-ed25519 AAAAOWNER taken' }) });
    assert.equal(mine.status, 201);

    const stolen = await apps(base, { method: 'POST', body: registration({ id: 'taken', agent: '999', publicKey: 'ssh-ed25519 AAAATHIEF taken' }) });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error, 'agent_mismatch');

    // An application that declares no owner is not up for grabs either.
    const orphan = await apps(base, { method: 'POST', body: registration({ id: 'other', agent: '999', publicKey: 'ssh-ed25519 AAAAORPHAN other' }) });
    assert.equal(orphan.status, 409);

    // Untouched: same owner, same key, same port.
    const stored = config.read().apps.filter(app => app.id === 'taken');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].agent, '365');
    assert.equal(stored[0].publicKey, 'ssh-ed25519 AAAAOWNER taken');
    assert.equal(stored[0].remotePort, mine.body.remote_port);

    // The owner can still update, and still keeps the port.
    const again = await apps(base, { method: 'POST', body: registration({ id: 'taken', agent: '365', publicKey: 'ssh-ed25519 AAAAROTATED taken' }) });
    assert.equal(again.status, 201);
    assert.equal(again.body.status, 'updated');
    assert.equal(again.body.remote_port, mine.body.remote_port);
  }, config);
});

test('a new application is visible to every route at once', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    const created = await apps(base, { method: 'POST', body: registration() });
    assert.equal(created.status, 201);

    const listed = await apps(base);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.apps.map(app => app.id), ['demo', 'other', 'board']);
    const board = listed.body.apps.find(app => app.id === 'board');
    assert.equal(board.remote_port, created.body.remote_port);
    assert.equal(board.agent, '365');
    assert.deepEqual(board.urls, created.body.urls);
    assert.ok(!('publicKey' in board), 'the inventory never reads the public key back');
    assert.ok(!JSON.stringify(listed.body).includes('AAAABOARD'));

    const sidebar = await (await fetch(`${base}/api/apps`)).json();
    assert.deepEqual(sidebar.apps.map(app => app.id), ['demo', 'other', 'board']);
    assert.equal(sidebar.apps[2].url, 'https://artifact.example.cc/board/');

    // `known` was recomputed with the same snapshot, so the identity routes
    // stopped answering 404 for the application that just appeared.
    const me = await fetch(`${base}/_gateway/me?app=board`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { contract: VIEWER_CONTRACT, authenticated: false, viewer: null, app_id: 'board', topic_id: null, expires_at: null });

    const { body } = await issue(base, { app: 'board', uid: 'u1' });
    assert.equal((await fetch(`${body.launch_url.replace('https://artifact.example.cc', base)}`, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${base}/_auth/declined?app=board`)).status, 200);
  }, config);
});

test('two registrations in flight both persist', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    // The read-modify-write is synchronous inside each request, so the event
    // loop cannot interleave two of them: no update can be lost.
    const [one, two] = await Promise.all([
      apps(base, { method: 'POST', body: registration({ id: 'alpha', publicKey: 'ssh-ed25519 AAAAALPHA alpha' }) }),
      apps(base, { method: 'POST', body: registration({ id: 'beta', publicKey: 'ssh-ed25519 AAAABETA beta' }) }),
    ]);
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.deepEqual(config.read().apps.map(app => app.id), ['demo', 'other', 'alpha', 'beta']);
    assert.notEqual(one.body.remote_port, two.body.remote_port);
  }, config);
});

test('an application can be unregistered, but not the last one', async () => {
  const config = registrationConfig();
  await withServer(async ({ base }) => {
    await apps(base, { method: 'POST', body: registration() });
    const removed = await apps(base, { method: 'DELETE', path: '/_gateway/apps/board' });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { status: 'removed', id: 'board' });
    assert.deepEqual(config.read().apps.map(app => app.id), ['demo', 'other']);
    assert.equal((await fetch(`${base}/_gateway/me?app=board`)).status, 404, 'the routes forget it immediately');
    assert.equal((await apps(base)).body.apps.length, 2);

    assert.equal((await apps(base, { method: 'DELETE', path: '/_gateway/apps/board' })).status, 404, 'removing twice is a 404');
    assert.equal((await apps(base, { method: 'DELETE', path: '/_gateway/apps/ghost' })).status, 404, 'an unknown id is a 404');
    assert.equal((await apps(base, { method: 'GET', path: '/_gateway/apps/board' })).status, 405);

    assert.equal((await apps(base, { method: 'DELETE', path: '/_gateway/apps/demo' })).status, 200);
    const last = await apps(base, { method: 'DELETE', path: '/_gateway/apps/other' });
    assert.equal(last.status, 409, 'an empty application list cannot be rendered');
    assert.equal(last.body.error, 'last_application');
    assert.deepEqual(config.read().apps.map(app => app.id), ['other']);
  }, config);
});

test('an exhausted port range is reported instead of reused', async () => {
  // A one-port range that is already taken: the allocation must fail loudly
  // rather than hand out a port a running tunnel is using.
  const config = registrationConfig([{ id: 'taken', remotePort: 28200, publicKey: 'ssh-ed25519 AAAATAKEN taken', agent: '365' }]);
  await withServer(async ({ base }) => {
    const res = await apps(base, { method: 'POST', body: registration() });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'no_free_remote_port');
    assert.match(res.body.message, /28200 and 28200/);
    assert.deepEqual(config.read(), config.content);
  }, { configPath: config.configPath, remotePortBase: 28200, remotePortCeiling: 28200 });
});

test('registration is unavailable without a config file to write', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await apps(base)).status, 200, 'the inventory still answers from the loaded config');
    for (const call of [{ method: 'POST', body: registration() }, { method: 'DELETE', path: '/_gateway/apps/demo' }]) {
      const res = await apps(base, call);
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'registration_unavailable');
    }
  });
});


