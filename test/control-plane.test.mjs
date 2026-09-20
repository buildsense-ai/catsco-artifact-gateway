import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ViewerStore, pseudonym, COOKIE_NAME, VIEWER_CONTRACT } from '../src/viewer-store.mjs';
import { createControlPlane, buildAppList, matchBySuffix, safeNext, handshakeTarget, DEFAULT_HANDSHAKE_URL } from '../src/control-plane.mjs';
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
  const store = new ViewerStore({ file: tmpState(), ...options });
  const server = createControlPlane({
    config: CONFIG,
    store,
    controlToken: CONTROL_TOKEN,
    cookieSecure: false,
    corsOrigins: ['https://app.example.cc'],
    handshakeUrl: options.handshakeUrl,
    handshakeUrls: options.handshakeUrls,
    platformIdentityUrl: options.platformIdentityUrl,
    platformCookieName: options.platformCookieName,
    platformIdentityTimeoutMs: options.platformIdentityTimeoutMs,
    // Default to a fetcher that refuses, so no test can silently reach the real
    // platform; the platform tests inject a loopback one.
    fetchImpl: options.fetchImpl || (() => { throw new Error('unexpected platform call'); }),
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
  const apps = buildAppList(CONFIG, { updatedAt: '2026-09-17T00:00:00.000Z' });
  assert.deepEqual(apps, [
    { id: 'demo', title: '演示应用', url: 'https://artifact.example.cc/demo/', status: 'ready', updated_at: '2026-09-17T00:00:00.000Z' },
    { id: 'other', title: 'other', url: 'https://artifact.example.cc/other/', status: 'ready', updated_at: '2026-09-17T00:00:00.000Z' },
  ]);
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
  assert.ok(r.locations.includes('location ^~ /_launch/'));
  assert.ok(r.locations.includes('location = /api/apps'));
  assert.ok(r.locations.includes('proxy_pass http://127.0.0.1:22445'));
  const appBlock = r.locations.split('location ^~ /demo/')[1];
  assert.ok(!appBlock.includes('proxy_set_header Cookie ""'), 'application path must receive the viewer cookie');
  assert.ok(!appBlock.includes('proxy_hide_header Set-Cookie'), 'application path may set its own cookies');
  assert.ok(r.locations.includes('proxy_set_header Cookie ""'), 'tunnel and control-plane ingress still strip cookies');
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

