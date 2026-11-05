import fs from 'node:fs';
import { renderGateway } from '../src/gateway-config.mjs';
import { remotePortAvailable } from '../src/remote-ports.mjs';
const [file, publicKeyFile, id, remotePort] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
c.apps.push({ id, remotePort: Number(remotePort), publicKey: fs.readFileSync(publicKeyFile, 'utf8').trim() });
renderGateway(c);
if (!await remotePortAvailable(Number(remotePort))) throw new Error(`Port ${remotePort} is already listening`);
fs.writeFileSync(file, JSON.stringify(c, null, 2));
