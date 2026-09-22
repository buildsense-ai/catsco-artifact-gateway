import fs from 'node:fs';
import path from 'node:path';
import { renderGateway } from '../src/gateway-config.mjs';

// Registration is the one step that needs the gateway host, so this script is
// for whoever operates the gateway (a bot can also run it against a copy and
// hand the file over). It validates through the same renderer the deployment
// uses, so a registration that would break sshd or nginx fails here instead.
const [file, second, third] = process.argv.slice(2);
if (!file) {
  throw new Error([
    'Usage:',
    '  register-app GATEWAY_JSON REGISTRATION_JSON   add or update one application',
    '  register-app GATEWAY_JSON --remove APP_ID     unregister one application',
    '  register-app GATEWAY_JSON --list             show applications and their owners',
  ].join('\n'));
}

const config = JSON.parse(fs.readFileSync(file, 'utf8'));

function write(next) {
  renderGateway(next);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

if (second === '--list') {
  const rows = (config.apps || []).map(app => ({
    id: app.id,
    title: app.title ?? app.id,
    agent: app.agent ?? null,
    owned: app.agent !== undefined,
    remotePort: app.remotePort,
  }));
  const orphans = rows.filter(row => !row.owned).map(row => row.id);
  console.log(JSON.stringify({ apps: rows, unowned: orphans }, null, 2));
  if (orphans.length) console.error(`warning: ${orphans.join(', ')} declare no owner and will not appear in any bot's sidebar`);
  process.exit(0);
}

if (second === '--remove') {
  if (!third) throw new Error('--remove needs an application id');
  const next = { ...config, apps: (config.apps || []).filter(app => app.id !== third) };
  if (next.apps.length === (config.apps || []).length) throw new Error(`Unknown application: ${third}`);
  write(next);
  console.log(JSON.stringify({ status: 'removed', id: third }, null, 2));
  process.exit(0);
}

if (!second) throw new Error('Missing registration file');
const registration = JSON.parse(fs.readFileSync(path.resolve(second), 'utf8'));
if (!registration.id || !registration.publicKey) throw new Error('Registration file needs at least id and publicKey');
if (registration.agent === undefined) throw new Error('Registration file declares no owner: the application would appear in no bot\'s sidebar');

const previous = (config.apps || []).find(app => app.id === registration.id);
const entry = {
  id: registration.id,
  title: registration.title ?? registration.id,
  agent: String(registration.agent),
  remotePort: Number(registration.remotePort),
  publicKey: String(registration.publicKey).trim(),
  // Same rule the API applies: a registration that does not declare a body
  // ceiling keeps the stored one, so re-running this to rotate a key cannot
  // silently shrink the uploads the application already accepts. Writing the
  // field is what makes the ceiling survive the next apply, which re-renders
  // the nginx include from this file.
  maxBody: registration.maxBody ?? previous?.maxBody,
};
const others = (config.apps || []).filter(app => app.id !== entry.id);
if (others.some(app => app.remotePort === entry.remotePort)) throw new Error(`Port ${entry.remotePort} is already registered`);
const entryKey = entry.publicKey.split(' ')[1];
if (others.some(app => app.publicKey.split(' ')[1] === entryKey)) throw new Error('This key is already registered to another application');

const replaced = (config.apps || []).some(app => app.id === entry.id);
write({ ...config, apps: [...others, entry] });
console.log(JSON.stringify({ status: replaced ? 'updated' : 'registered', id: entry.id, agent: entry.agent, remotePort: entry.remotePort }, null, 2));
