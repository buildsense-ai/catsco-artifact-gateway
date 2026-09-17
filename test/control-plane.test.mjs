import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ViewerStore, pseudonym, COOKIE_NAME, VIEWER_CONTRACT } from '../src/viewer-store.mjs';
import { createControlPlane, buildAppList } from '../src/control-plane.mjs';
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
  const server = createControlPlane({ config: CONFIG, store, controlToken: CONTROL_TOKEN, cookieSecure: false, corsOrigins: ['https://app.example.cc'], logger: { error() {} } });
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
