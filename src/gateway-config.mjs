import { appTitle, bodySizeBytes, botUid, name, port } from './config.mjs';

// What an application may declare for its own request body, and what one that
// declares nothing gets. The default is deliberately not tiny: most published
// applications accept some upload, and a default that rejects an ordinary image
// pushes every publisher into declaring a value just to work — which is how the
// limit came to be hand-edited on the gateway host in the first place. An
// application that wants a different value declares one; the ceiling below still
// bounds what any single application can ask for, because the gateway host's
// disk is shared with the platform (see bodySize).
export const maxBodyCeilingBytes = 256 * 1024 ** 2;
export const defaultMaxBody = '64m';
// The default is checked against the ceiling too. Only a declared `a.maxBody`
// used to pass through the validator, so lowering the ceiling below the default
// would have rendered a value that silently exceeded it: every application that
// declared nothing would keep the old, larger limit while the ceiling claimed
// otherwise. Failing at load makes that combination impossible to deploy, and it
// rejects a default written with a unit the parser does not understand.
bodySizeBytes(defaultMaxBody, maxBodyCeilingBytes);

// P0 only: trusted disposable demos, not arbitrary untrusted HTML hosting.
export function renderGateway(c) {
  port(c.sshPort); name(c.user);
  if (!Array.isArray(c.apps) || !c.apps.length) throw new Error('No applications');
  const hosts = c.publicHosts;
  if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length || hosts.some(h => typeof h !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(h))) throw new Error('Invalid publicHosts');
  for (const field of ['hostKey', 'authorizedKeys']) if (!/^\/[a-zA-Z0-9/_.-]+$/.test(c[field])) throw new Error(`Invalid ${field}`);
  const controlPort = c.controlPort === undefined ? null : port(c.controlPort);
  const ids = new Set(), ports = new Set([c.sshPort, 22444, controlPort].filter(Boolean)), keys = new Set();
  for (const a of c.apps) {
    name(a.id); port(a.remotePort);
    if (ids.has(a.id) || ports.has(a.remotePort)) throw new Error('Duplicate application/port');
    ids.add(a.id); ports.add(a.remotePort);
    if (a.agent !== undefined) botUid(a.agent);
    if (a.title !== undefined) appTitle(a.title);
    if (a.maxBody !== undefined) bodySizeBytes(a.maxBody, maxBodyCeilingBytes);
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(a.publicKey)) throw new Error('Expected ed25519 public key');
    const key = a.publicKey.split(' ')[1];
    if (keys.has(key)) throw new Error('Each application must use a distinct key');
    keys.add(key);
  }
  // Control plane routes are shared by every application, so they are rendered
  // once instead of per application. They forward the browser's own Host: the
  // control plane picks a public domain and a handshake page by suffix, and
  // without this nginx would send `127.0.0.1:<controlPort>` instead, leaving the
  // lookup with nothing to match and silently falling back to the first domain —
  // so a `.cn` visitor would be sent to the `.cc` login page, which is exactly
  // the cross-site hop this is meant to avoid.
  const control = controlPort === null ? '' : `location = /api/apps { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie ""; proxy_hide_header Set-Cookie; proxy_buffering off; limit_req zone=cag_p0_requests burst=20 nodelay; limit_conn cag_p0_connections 20; }
location = /_gateway/health { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie ""; proxy_hide_header Set-Cookie; proxy_buffering off; limit_req zone=cag_p0_requests burst=10 nodelay; }
location = /_gateway/me { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie $http_cookie; proxy_set_header Authorization $http_authorization; proxy_buffering off; limit_req zone=cag_p0_requests burst=20 nodelay; limit_conn cag_p0_connections 20; }
location = /_gateway/codes { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie ""; proxy_hide_header Set-Cookie; proxy_buffering off; limit_req zone=cag_p0_requests burst=10 nodelay; }
location ^~ /_gateway/apps { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie ""; proxy_hide_header Set-Cookie; proxy_buffering off; limit_req zone=cag_p0_requests burst=10 nodelay; }
location ^~ /_auth/ { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie ""; proxy_hide_header Set-Cookie; proxy_buffering off; limit_req zone=cag_p0_requests burst=10 nodelay; }
location ^~ /_launch/ { proxy_pass http://127.0.0.1:${controlPort}; proxy_set_header Host $host; proxy_set_header Cookie ""; proxy_buffering off; limit_req zone=cag_p0_requests burst=10 nodelay; }
`;
  return {
    sshd: `Port ${c.sshPort}\nListenAddress 127.0.0.1\nHostKey ${c.hostKey}\nPidFile /run/catsco-artifact-gateway.pid\nAuthorizedKeysFile ${c.authorizedKeys}\nAllowUsers ${c.user}\nPubkeyAuthentication yes\nAuthenticationMethods publickey\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nUsePAM yes\nAllowTcpForwarding remote\nAllowStreamLocalForwarding no\nGatewayPorts no\nPermitListen ${c.apps.map(a => `127.0.0.1:${a.remotePort}`).join(' ')}\nPermitOpen none\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nPermitTTY no\nPermitUserEnvironment no\nMaxSessions 0\nMaxAuthTries 3\nMaxStartups 10:30:30\nLoginGraceTime 20\nClientAliveInterval 15\nClientAliveCountMax 2\nLogLevel VERBOSE\n`,
    authorizedKeys: c.apps.map(a => `restrict,port-forwarding,permitlisten="127.0.0.1:${a.remotePort}" ${a.publicKey.split(' ').slice(0, 2).join(' ')} ${a.id}`).join('\n') + '\n',
    nginx: `# http-context only; ordinary CatsCompany locations are unaffected.\nlimit_req_zone $binary_remote_addr zone=cag_p0_requests:1m rate=10r/s;\nlimit_conn_zone $binary_remote_addr zone=cag_p0_connections:1m;\nmap $http_upgrade $cag_p0_upgrade { default upgrade; '' close; }\n`,
    locations: `# Include only in dedicated Artifact virtual hosts.\nlocation = /_gateway/tunnel {\n proxy_pass http://127.0.0.1:22444/tunnel;\n proxy_http_version 1.1;\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection "upgrade";\n proxy_set_header Cookie "";\n proxy_read_timeout 65s;\n proxy_buffering off;\n limit_req zone=cag_p0_requests burst=10 nodelay;\n limit_conn cag_p0_connections 8;\n}\n` + control + c.apps.map(a => `location = /${a.id} { return 308 /${a.id}/; }\nlocation ^~ /${a.id}/ {\n proxy_pass http://127.0.0.1:${a.remotePort}/;\n proxy_http_version 1.1;\n proxy_set_header Host $host;\n proxy_set_header Upgrade $http_upgrade;\n proxy_set_header Connection $cag_p0_upgrade;\n proxy_set_header X-Forwarded-Proto https;\n proxy_set_header X-Forwarded-For $remote_addr;\n proxy_buffering off;\n proxy_read_timeout 65s;\n proxy_connect_timeout 3s;\n client_max_body_size ${a.maxBody ?? defaultMaxBody};\n limit_req zone=cag_p0_requests burst=20 nodelay;\n limit_conn cag_p0_connections 20;\n add_header Cache-Control "no-store" always;\n add_header X-Content-Type-Options "nosniff" always;\n add_header Referrer-Policy "no-referrer" always;\n add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src ${hosts.map(h => `https://${h}/${a.id}/ wss://${h}/${a.id}/`).join(' ')}; img-src 'self' data: blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; worker-src 'self' blob:; object-src 'none'" always;\n}\n`).join('')
  };
}
