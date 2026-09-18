import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appTitle, botUid, validateConnector } from '../src/config.mjs';

// Positional arguments keep the original shape; --agent and --title are the
// bot-facing part: --agent declares which bot owns the application, which is
// what keeps it out of every other bot's sidebar.
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--agent' || arg === '--title') {
    if (argv[i + 1] === undefined) throw new Error(`Missing value for ${arg}`);
    flags[arg.slice(2)] = argv[++i];
    continue;
  }
  if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
  positional.push(arg);
}

const [directory, appId, host, sshPort, remotePort, localPort, gatewayHostKey, transportUrl] = positional;
if (!gatewayHostKey) throw new Error('Usage: init-connector DIR APP HOST SSH_PORT REMOTE_PORT LOCAL_PORT VERIFIED_HOST_PUBLIC_KEY_FILE [TRANSPORT_URL] --agent BOT_UID [--title NAME]');
if (flags.agent === undefined) throw new Error('Missing --agent: an application must declare the bot it belongs to (read it from CATSCOMPANY_BOT_UID)');
const agent = botUid(flags.agent);
const title = appTitle(flags.title ?? appId);

const dir = path.resolve(directory);
const config = validateConnector({ appId, agent, title, host, user: 'cag_ingress', transportUrl, sshPort: Number(sshPort), remotePort: Number(remotePort), localPort: Number(localPort), identityFile: path.join(dir, 'id_ed25519'), knownHostsFile: path.join(dir, 'known_hosts'), statusFile: path.join(dir, 'status.json') });
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

// The handoff to the platform: everything needed to register this application.
const registration = {
  id: appId,
  title,
  agent,
  remotePort: Number(remotePort),
  publicKey: fs.readFileSync(`${config.identityFile}.pub`, 'utf8').trim(),
};
const registrationPath = path.join(dir, 'registration.json');
fs.writeFileSync(registrationPath, JSON.stringify(registration, null, 2) + '\n', { mode: 0o600 });

console.log(JSON.stringify({
  appId,
  agent,
  title,
  osUid: process.getuid?.(),
  config: path.join(dir, 'connector.json'),
  registration: registrationPath,
  next: `node scripts/register-app.mjs <gateway.json> ${registrationPath}`,
}, null, 2));
