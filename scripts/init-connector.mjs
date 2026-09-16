import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateConnector } from '../src/config.mjs';
const [directory, appId, host, sshPort, remotePort, localPort, gatewayHostKey, transportUrl] = process.argv.slice(2);
if (!gatewayHostKey) throw new Error('Usage: init-connector DIR APP HOST SSH_PORT REMOTE_PORT LOCAL_PORT VERIFIED_HOST_PUBLIC_KEY_FILE');
const dir = path.resolve(directory);
const config = validateConnector({ appId, host, user: 'cag_ingress', transportUrl, sshPort: Number(sshPort), remotePort: Number(remotePort), localPort: Number(localPort), identityFile: path.join(dir, 'id_ed25519'), knownHostsFile: path.join(dir, 'known_hosts'), statusFile: path.join(dir, 'status.json') });
const publicKey = fs.readFileSync(gatewayHostKey, 'utf8').trim();
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey)) throw new Error('Invalid gateway public key');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(config.identityFile)) {
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', config.identityFile], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('ssh-keygen failed');
}
const pin = `[${host}]:${sshPort} ${publicKey.split(' ').slice(0, 2).join(' ')}\n`;
if (fs.existsSync(config.knownHostsFile) && fs.readFileSync(config.knownHostsFile, 'utf8') !== pin) throw new Error('Existing host pin differs: explicit key rotation required');
fs.writeFileSync(config.knownHostsFile, pin, { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'connector.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ appId, uid: process.getuid?.(), config: path.join(dir, 'connector.json'), publicKey: fs.readFileSync(config.identityFile + '.pub', 'utf8').trim() }));
