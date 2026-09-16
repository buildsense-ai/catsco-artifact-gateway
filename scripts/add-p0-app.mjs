import fs from 'node:fs';
import { renderGateway } from '../src/gateway-config.mjs';
const [file, publicKeyFile, id, remotePort] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
c.apps.push({ id, remotePort: Number(remotePort), publicKey: fs.readFileSync(publicKeyFile, 'utf8').trim() });
renderGateway(c); fs.writeFileSync(file, JSON.stringify(c, null, 2));
