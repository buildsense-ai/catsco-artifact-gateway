import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sshArgs } from '../src/config.mjs';
const c = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-auth-probe-'));
try {
  const fake = path.join(temporary, 'key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', fake]).status, 0);
  const pin = path.join(temporary, 'known_hosts');
  fs.writeFileSync(pin, `[${c.host}]:${c.sshPort} ${fs.readFileSync(fake + '.pub', 'utf8')}`);
  const mismatch = spawnSync('ssh', sshArgs({ ...c, knownHostsFile: pin }), { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
  const unauthorized = spawnSync('ssh', sshArgs({ ...c, identityFile: fake }), { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(unauthorized.status, 0); assert.match(unauthorized.stderr, /Permission denied/);
  console.log(JSON.stringify({ hostKeyMismatch: 'denied', unregisteredKey: 'denied' }));
} finally {
  for (const file of ['key', 'key.pub', 'known_hosts']) if (fs.existsSync(path.join(temporary, file))) fs.unlinkSync(path.join(temporary, file));
  fs.rmdirSync(temporary);
}
