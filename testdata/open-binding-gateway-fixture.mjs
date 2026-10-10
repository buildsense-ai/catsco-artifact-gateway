#!/usr/bin/env node
// Local joint-test fixture: real control plane + real renderer. Not an HTML
// proxy, not production configuration. The application has no SDK script.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ViewerStore } from '../src/viewer-store.mjs';
import { createControlPlane } from '../src/control-plane.mjs';
import { renderGateway } from '../src/gateway-config.mjs';

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '0.0.0.0', () => resolve(server.address().port));
});
export async function startGatewayFixture({ directory, controlToken = 'joint-fixture-control-token-0123456789abcdef', parentOrigin = 'http://127.0.0.1:3080', agent = '365', appPort = 0, controlPort = 0, nginxPort = 3081 } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('absolute fixture directory required');
  fs.mkdirSync(directory, { recursive: true });
  const app = http.createServer((req, res) => {
    const html = '<!doctype html><html><head><title>Gateway joint fixture</title></head><body><button id="target">Gateway target</button><p id="text">Actual fixture annotation text</p></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors ${parentOrigin}` });
    res.end(html);
  });
  const remotePort = await listen(app, appPort);
  const config = {
    sshPort: 22443, user: 'cag', publicHosts: ['artifact.catsco.cc'], hostKey: '/etc/cag/key', authorizedKeys: '/etc/cag/keys',
    annotationRuntime: { enabled: true, directory: '/runtime', parentOrigins: [parentOrigin] },
    apps: [{ id: 'joint-app', agent, remotePort, publicKey: 'ssh-ed25519 AAAAFIXTUREONLY', annotations: true }],
  };
  const store = new ViewerStore({ file: path.join(directory, 'viewer-state.json') });
  const control = createControlPlane({ config, store, controlToken, cookieSecure: false, platformIdentityUrl: '', statusProbe: { probeAll: async () => new Map([['joint-app', 'online']]) } });
  config.controlPort = await listen(control, controlPort);
  const rendered = renderGateway(config);
  const locations = rendered.locations.replaceAll(`127.0.0.1:${remotePort}/`, `host.docker.internal:${remotePort}/`).replaceAll(`127.0.0.1:${config.controlPort}`, `host.docker.internal:${config.controlPort}`);
  const nginxConfig = `events {}\nhttp { ${rendered.nginx}\nserver { listen ${nginxPort}; ${locations}\n} }\n`;
  fs.writeFileSync(path.join(directory, 'gateway.json'), JSON.stringify(config, null, 2) + '\n');
  for (const [name, content] of Object.entries(rendered)) fs.writeFileSync(path.join(directory, name), content);
  fs.writeFileSync(path.join(directory, 'nginx.conf'), nginxConfig);
  return {
    config, store, control, app,
    info: { app_id: 'joint-app', agent_uid: Number(agent), control_url: `http://127.0.0.1:${config.controlPort}`, nginx_url: `http://127.0.0.1:${nginxPort}`, runtime_directory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/runtime'), output_directory: directory },
    async close() { app.closeAllConnections(); control.closeAllConnections(); await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => control.close(resolve))]); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startGatewayFixture({ directory: path.resolve(process.argv[2] || '/tmp/cag-open-binding-joint'), parentOrigin: process.env.CAG_FIXTURE_PARENT_ORIGIN || 'http://127.0.0.1:3080', agent: process.env.CAG_FIXTURE_AGENT || '365', nginxPort: Number(process.env.CAG_FIXTURE_NGINX_PORT || 3081), controlToken: process.env.CAG_FIXTURE_CONTROL_TOKEN || 'joint-fixture-control-token-0123456789abcdef' });
  console.log(JSON.stringify(fixture.info, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
