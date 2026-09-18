import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ViewerStore, pseudonym, COOKIE_NAME, VIEWER_CONTRACT } from '../src/viewer-store.mjs';
import { createControlPlane, buildAppList, safeNext, handshakeTarget } from '../src/control-plane.mjs';
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
  const server = createControlPlane({ config: CONFIG, store, controlToken: CONTROL_TOKEN, cookieSecure: false, corsOrigins: ['https://app.example.cc'], handshakeUrl: options.handshakeUrl, logger: { error() {} } });
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
    assert.equal(location.pathname, '/artifact-auth');
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
