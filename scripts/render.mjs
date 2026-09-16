import fs from 'node:fs';
import path from 'node:path';
import { renderGateway } from '../src/gateway-config.mjs';
const result = renderGateway(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
fs.mkdirSync(process.argv[3], { recursive: true, mode: 0o700 });
for (const [name, content] of Object.entries(result)) fs.writeFileSync(path.join(process.argv[3], name), content, { mode: 0o600 });
