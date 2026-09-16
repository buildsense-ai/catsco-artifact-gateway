// Explicit operator action: change endpoint while retaining the verified SSH key.
import fs from 'node:fs';
import { validateConnector } from '../src/config.mjs';
const [file, host, transportUrl, trustedKeyFile] = process.argv.slice(2);
const c = validateConnector(JSON.parse(fs.readFileSync(file, 'utf8')));
const key = fs.readFileSync(trustedKeyFile, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) throw new Error('Invalid verified host key');
const lines = fs.readFileSync(c.knownHostsFile, 'utf8').trim().split(/\r?\n/);
if (!lines.some(line => line === `[${c.host}]:${c.sshPort} ${key}`)) throw new Error('Old endpoint does not match verified key');
const next = validateConnector({ ...c, host, transportUrl });
const alias = `[${host}]:${c.sshPort}`;
if (lines.some(line => line.startsWith(alias + ' ') && line !== `${alias} ${key}`)) throw new Error('Conflicting host pin');
fs.writeFileSync(c.knownHostsFile, [...new Set([...lines, `${alias} ${key}`])].join('\n') + '\n', { mode: 0o600 });
fs.writeFileSync(file + '.next', JSON.stringify(next, null, 2), { mode: 0o600 });
fs.renameSync(file + '.next', file);
console.log(JSON.stringify({ appId: c.appId, host, transportUrl, uid: process.getuid?.() }));
