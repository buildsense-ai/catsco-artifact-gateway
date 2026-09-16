import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sshArgs } from '../src/config.mjs';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = sshArgs(config).filter((value, i, all) => value !== '-N' && value !== '-R' && all[i - 1] !== '-R');
function denied(label, args, pattern) {
  const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 128000 });
  assert.match(r.stderr || '', /Authenticated to .*using "publickey"/, `${label}: must authenticate before checking authorization`);
  assert.notEqual(r.status, 0, label); assert.match(r.stderr || '', pattern, label);
  console.log(JSON.stringify({ check: label, denied: true }));
}
denied('shell', [...base, 'true'], /administratively prohibited|shell request failed|exec request failed|channel 0: open failed: connect failed: open failed/i);
denied('local_forward', [...base.slice(0,-1), '-W', '127.0.0.1:22', base.at(-1)], /administratively prohibited|stdio forwarding failed/i);
denied('unassigned_remote_port', sshArgs({ ...config, remotePort: 28299 }), /remote port forwarding failed/i);
if (process.argv[3]) denied('other_application_free_port', sshArgs({ ...config, remotePort: Number(process.argv[3]) }), /remote port forwarding failed/i);
