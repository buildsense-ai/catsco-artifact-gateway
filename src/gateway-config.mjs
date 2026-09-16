import { name, port } from './config.mjs';

// P0 only: trusted disposable demos, not arbitrary untrusted HTML hosting.
export function renderGateway(c) {
  port(c.sshPort); name(c.user);
  if (!Array.isArray(c.apps) || !c.apps.length) throw new Error('No applications');
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(c.publicHost)) throw new Error('Invalid hostname');
  for (const field of ['hostKey', 'authorizedKeys']) if (!/^\/[a-zA-Z0-9/_.-]+$/.test(c[field])) throw new Error(`Invalid ${field}`);
  const ids = new Set(), ports = new Set([c.sshPort, 22444]), keys = new Set();
  for (const a of c.apps) {
    name(a.id); port(a.remotePort);
    if (ids.has(a.id) || ports.has(a.remotePort)) throw new Error('Duplicate application/port');
    ids.add(a.id); ports.add(a.remotePort);
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(a.publicKey)) throw new Error('Expected ed25519 public key');
    const key = a.publicKey.split(' ')[1];
    if (keys.has(key)) throw new Error('Each application must use a distinct key');
    keys.add(key);
  }
  return {
    sshd: `Port ${c.sshPort}\nListenAddress 127.0.0.1\nHostKey ${c.hostKey}\nPidFile /run/catsco-artifact-gateway.pid\nAuthorizedKeysFile ${c.authorizedKeys}\nAllowUsers ${c.user}\nPubkeyAuthentication yes\nAuthenticationMethods publickey\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nUsePAM yes\nAllowTcpForwarding remote\nAllowStreamLocalForwarding no\nGatewayPorts no\nPermitListen ${c.apps.map(a => `127.0.0.1:${a.remotePort}`).join(' ')}\nPermitOpen none\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nPermitTTY no\nPermitUserEnvironment no\nMaxSessions 0\nMaxAuthTries 3\nMaxStartups 10:30:30\nLoginGraceTime 20\nClientAliveInterval 15\nClientAliveCountMax 2\nLogLevel VERBOSE\n`,
    authorizedKeys: c.apps.map(a => `restrict,port-forwarding,permitlisten="127.0.0.1:${a.remotePort}" ${a.publicKey.split(' ').slice(0, 2).join(' ')} ${a.id}`).join('\n') + '\n',
    nginx: `# http-context only; ordinary CatsCompany locations are unaffected.\nlimit_req_zone $binary_remote_addr zone=cag_p0_requests:1m rate=10r/s;\nlimit_conn_zone $binary_remote_addr zone=cag_p0_connections:1m;\nmap $http_upgrade $cag_p0_upgrade { default upgrade; '' close; }\n`,
    locations: `# Include in preview vhost, never app.catsco.cc.\nlocation = /_cag_p0/tunnel {\n proxy_pass http://127.0.0.1:22444/tunnel;\n proxy_http_version 1.1;\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection "upgrade";\n proxy_set_header Cookie "";\n proxy_read_timeout 65s;\n proxy_buffering off;\n limit_req zone=cag_p0_requests burst=10 nodelay;\n limit_conn cag_p0_connections 8;\n}\n` + c.apps.map(a => `location = /_cag_p0/${a.id} { return 308 /_cag_p0/${a.id}/; }\nlocation ^~ /_cag_p0/${a.id}/ {\n proxy_pass http://127.0.0.1:${a.remotePort}/;\n proxy_http_version 1.1;\n proxy_set_header Host $host;\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection $cag_p0_upgrade;\n proxy_set_header X-Forwarded-Proto https;\n proxy_set_header X-Forwarded-For $remote_addr;\n proxy_set_header Cookie "";\n proxy_hide_header Set-Cookie;\n proxy_buffering off;\n proxy_read_timeout 65s;\n proxy_connect_timeout 3s;\n client_max_body_size 1m;\n limit_req zone=cag_p0_requests burst=20 nodelay;\n limit_conn cag_p0_connections 20;\n add_header Cache-Control "no-store" always;\n add_header X-Content-Type-Options "nosniff" always;\n add_header Referrer-Policy "no-referrer" always;\n add_header Content-Security-Policy "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https://${c.publicHost}/_cag_p0/${a.id}/; base-uri 'none'; form-action 'none'; worker-src 'none'" always;\n}\n`).join('')
  };
}
