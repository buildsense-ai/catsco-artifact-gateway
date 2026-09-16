import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
test('endpoint migration preserves keys and rejects host-key changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-test-'));
  try {
    const key = 'ssh-ed25519 AAAATEST';
    const c = { appId: 'demo', user: 'cag', host: 'old.example.com', sshPort: 22443, remotePort: 28191, localPort: 20171, identityFile: path.join(dir, 'key'), knownHostsFile: path.join(dir, 'known'), statusFile: path.join(dir, 'status') };
    const file = path.join(dir, 'connector.json'), pub = path.join(dir, 'host.pub');
    fs.writeFileSync(file, JSON.stringify(c)); fs.writeFileSync(pub, key);
    fs.writeFileSync(c.identityFile, 'unchanged-secret');
    fs.writeFileSync(c.knownHostsFile, `[old.example.com]:22443 ${key}\n`);
    const run = () => spawnSync(process.execPath, ['scripts/migrate-endpoint.mjs', file, 'artifact.example.cn', 'wss://artifact.example.cn/_gateway/tunnel', pub]);
    assert.equal(run().status, 0); assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(c.identityFile, 'utf8'), 'unchanged-secret');
    assert.equal(JSON.parse(fs.readFileSync(file)).host, 'artifact.example.cn');
    assert.equal(fs.readFileSync(c.knownHostsFile, 'utf8').trim().split('\n').length, 2);
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(pub, 'ssh-ed25519 WRONGKEY');
    assert.notEqual(run().status, 0); assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
