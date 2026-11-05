import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocateRemotePort, inspectLease, LEASE, remotePortAvailable, retireRemotePort } from '../src/remote-ports.mjs';
import { renderGateway } from '../src/gateway-config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = () => ({
  sshPort: 22443, user: 'cag_ingress', controlPort: 22445,
  publicHosts: ['artifact.example.cc'], hostKey: '/etc/cag/key', authorizedKeys: '/etc/cag/keys',
  apps: [
    { id: 'demo', agent: '365', remotePort: 28191, publicKey: 'ssh-ed25519 AAAADEMO demo' },
    { id: 'other', agent: '365', remotePort: 28192, publicKey: 'ssh-ed25519 AAAAOTHER other' },
  ],
});

async function listener(fn) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try { await fn(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-ports-'));
  const file = path.join(dir, 'gateway.json');
  fs.writeFileSync(file, JSON.stringify(config()));
  return {
    dir, file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    run: (...args) => spawnSync(process.execPath, ['scripts/register-app.mjs', file, ...args], { cwd: root, encoding: 'utf8' }),
    registration: entry => {
      const filename = path.join(dir, 'registration.json');
      fs.writeFileSync(filename, JSON.stringify(entry));
      return filename;
    },
  };
}

test('allocation excludes active, reserved and retired ports before probing sockets', async () => {
  const candidates = [];
  const result = await allocateRemotePort({ apps: [{ remotePort: 28201 }], retiredRemotePorts: [28202] }, {
    base: 28200, ceiling: 28205, reserved: [28200],
    available: async candidate => { candidates.push(candidate); return candidate !== 28203; },
  });
  assert.equal(result, 28204);
  assert.deepEqual(candidates, [28203, 28204]);
});

test('a non-HTTP listener is unavailable and a released port can be probed again', async () => {
  let released;
  await listener(async port => {
    released = port;
    assert.equal(await remotePortAvailable(port), false);
    assert.equal(await allocateRemotePort({ apps: [] }, { base: port, ceiling: port, reserved: [] }), null);
  });
  assert.equal(await remotePortAvailable(released), true);
});

test('port inspection failures propagate instead of being treated as availability', async () => {
  await assert.rejects(allocateRemotePort({ apps: [] }, {
    base: 28200, ceiling: 28201, reserved: [],
    available: async () => { throw Object.assign(new Error('refused'), { code: 'EACCES' }); },
  }), /refused/);
});

test('the renderer refuses an active application on a retired port and malformed retirement records', () => {
  assert.throws(() => renderGateway(retireRemotePort(config(), 28191)), /Duplicate application\/port/);
  for (const retiredRemotePorts of [null, '28201', [80], ['28201'], [65536]]) {
    assert.throws(() => renderGateway({ ...config(), retiredRemotePorts }));
  }
  assert.ok(renderGateway({ ...config(), retiredRemotePorts: [28201] }));
});

test('CLI removal persists retirement and a new application cannot claim the old port', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  assert.equal(f.run('--remove', 'other').status, 0);
  assert.deepEqual(f.read().retiredRemotePorts, [28192]);
  const before = fs.readFileSync(f.file, 'utf8');
  const result = f.run(f.registration({ id: 'replacement', agent: '365', remotePort: 28192, publicKey: 'ssh-ed25519 AAAANEW replacement' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate application\/port/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('CLI registration refuses an orphaned live listener without modifying config', async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const before = fs.readFileSync(f.file, 'utf8');
  await listener(async port => {
    const result = f.run(f.registration({ id: 'replacement', agent: '365', remotePort: port, publicKey: 'ssh-ed25519 AAAANEW replacement' }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already listening/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  });
});

test('CLI updates keep a live application port, and moving it retires the old one', async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  await listener(async port => {
    const original = f.read();
    original.apps[1].remotePort = port;
    fs.writeFileSync(f.file, JSON.stringify(original));
    const entry = { ...original.apps[1], title: 'Renamed' };
    assert.equal(f.run(f.registration(entry)).status, 0, 'renaming must not reject the application own listener');
    assert.equal(f.read().apps.find(app => app.id === 'other').remotePort, port);
    const replacementPort = await allocateRemotePort(original, { base: 28201, ceiling: 65535, reserved: [] });
    const result = f.run(f.registration({ ...entry, remotePort: replacementPort }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.read().retiredRemotePorts, [port]);
    assert.equal(f.read().apps.find(app => app.id === 'other').remotePort, replacementPort);
  });
});

test('legacy add-p0-app cannot bypass retirement or live listener checks', async t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const publicKey = path.join(f.dir, 'key.pub');
  fs.writeFileSync(publicKey, 'ssh-ed25519 AAAANEW replacement');
  const original = { ...f.read(), retiredRemotePorts: [28201] };
  fs.writeFileSync(f.file, JSON.stringify(original));
  const run = port => spawnSync(process.execPath, ['scripts/add-p0-app.mjs', f.file, publicKey, 'replacement', String(port)], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run(28201).status, 0);
  await listener(async port => {
    assert.notEqual(run(port).status, 0);
    assert.deepEqual(f.read(), original);
  });
});


// What the port an application already holds is actually serving. This is the only
// thing that can tell a working mapping from one that answers as somebody else:
// both answer 200, so reachability cannot.

test('a port that claims this application has a sound lease', async () => {
  const lease = await inspectLease(28201, {
    appId: 'board',
    readIdentity: async () => ({ state: 'claimed', appId: 'board' }),
  });
  assert.equal(lease, LEASE.OURS);
});

test('a port that claims a different application is a broken lease', async () => {
  const lease = await inspectLease(28201, {
    appId: 'board',
    readIdentity: async () => ({ state: 'claimed', appId: 'somebody-else' }),
  });
  assert.equal(lease, LEASE.FOREIGN);
});

test('a port that makes no claim leaves the lease alone', async () => {
  // Most of the fleet predates the identity contract. Their ports must never be
  // reported as foreign, or adopting the check would move every application.
  for (const claim of [{ state: 'absent' }, { state: 'unusable' }, null]) {
    const lease = await inspectLease(28201, { appId: 'board', readIdentity: async () => claim });
    assert.equal(lease, claim?.state === 'unusable' ? LEASE.IDLE : LEASE.UNCLAIMED, JSON.stringify(claim));
  }
});

test('an inspector that forgets the application id cannot declare the port foreign', async () => {
  // Without a subject there is nothing to compare against. Treating that as
  // "foreign" would let a missing argument alone move a working application.
  for (const appId of [undefined, null, '', '   ']) {
    const lease = await inspectLease(28201, {
      appId,
      readIdentity: async () => ({ state: 'claimed', appId: 'board' }),
    });
    assert.equal(lease, LEASE.UNCLAIMED, `appId ${JSON.stringify(appId)}`);
  }
});
