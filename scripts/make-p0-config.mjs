import fs from 'node:fs';
const [publicKeyFile, out] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  sshPort: 22443, user: 'cag_ingress', publicHost: 'preview.catsco.cc',
  hostKey: '/etc/catsco-artifact-gateway/ssh_host_ed25519_key',
  authorizedKeys: '/etc/catsco-artifact-gateway/authorized_keys',
  apps: [{ id: 'saturday-demo', remotePort: 28191, publicKey: fs.readFileSync(publicKeyFile, 'utf8').trim() }]
}, null, 2), { mode: 0o600 });
