import test from 'node:test';
import assert from 'node:assert/strict';
import { sshArgs, validateConnector } from '../src/config.mjs';
import { renderGateway, defaultMaxBody } from '../src/gateway-config.mjs';
const c = { appId: 'demo', user: 'cag', host: 'example.com', sshPort: 22443, remotePort: 28191, localPort: 20171, identityFile: '/key', knownHostsFile: '/known', statusFile: '/status' };
const g = { sshPort: 22443, user: 'cag', publicHosts: ['artifact.example.cc', 'artifact.example.cn'], hostKey: '/etc/cag/key', authorizedKeys: '/etc/cag/keys', apps: [{ id: 'demo', remotePort: 28191, publicKey: 'ssh-ed25519 AAAATEST demo' }] };
test('connector pins host and binds only loopback without a remote shell', () => {
  const args = sshArgs(c); for (const x of ['StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', '-N', '-T', 'ForwardAgent=no', '127.0.0.1:28191:127.0.0.1:20171']) assert.ok(args.includes(x));
});
test('reject command injection and invalid ports', () => {
  for (const patch of [{ host: '-oProxyCommand=evil' }, { user: 'root\nPermitRootLogin yes' }, { localPort: 80 }, { remotePort: '28191' }, { identityFile: '/key\n' }]) assert.throws(() => validateConnector({ ...c, ...patch }));
});
test('connector records a declared owner and stays valid without one', () => {
  assert.equal(validateConnector({ ...c, agent: '365', title: '演示' }).agent, '365');
  assert.ok(validateConnector({ ...c }), 'a connector generated before ownership was recorded must keep working');
  for (const agent of ['bot', '0', '-1', 365.5, '', null]) assert.throws(() => validateConnector({ ...c, agent }));
  assert.throws(() => validateConnector({ ...c, title: ' ' }));
  assert.throws(() => validateConnector({ ...c, title: 'x'.repeat(61) }));
});
test('gateway validates application ownership', () => {
  assert.equal(renderGateway({ ...g, apps: [{ ...g.apps[0], agent: '365', title: '演示' }] }).locations.includes('location ^~ /demo/'), true);
  for (const agent of ['bot', '0', 0, '', 1.5]) assert.throws(() => renderGateway({ ...g, apps: [{ ...g.apps[0], agent }] }));
  assert.throws(() => renderGateway({ ...g, apps: [{ ...g.apps[0], title: '' }] }));
  assert.throws(() => renderGateway({ ...g, apps: [{ ...g.apps[0], title: 'x'.repeat(61) }] }));
  // Ownership is optional in the schema: an application without it renders, but
  // no bot-scoped caller will ever receive it.
  assert.ok(renderGateway({ ...g, apps: [{ ...g.apps[0] }] }).locations.includes('location ^~ /demo/'));
});
test('each application declares its own request body ceiling, bounded by the gateway', () => {
  // Absent means the small default, so every application published before the
  // field existed keeps the limit it was published under.
  assert.ok(renderGateway(g).locations.includes(`client_max_body_size ${defaultMaxBody};`));
  const declared = renderGateway({ ...g, apps: [{ ...g.apps[0], maxBody: '256m' }] }).locations;
  assert.ok(declared.includes('client_max_body_size 256m;'));
  assert.ok(!declared.includes(`client_max_body_size ${defaultMaxBody};`));
  // The ceiling is the point of the field. nginx buffers a request body before
  // handing it over, so an unbounded declaration is how one application fills the
  // disk the gateway host shares with the platform.
  for (const maxBody of ['257m', '1g', '0', '', '1m;', '1M ', '10000000000000', 1024, '1x', ' 1m', '1m\n', -1, null]) {
    assert.throws(() => renderGateway({ ...g, apps: [{ ...g.apps[0], maxBody }] }), `must reject maxBody ${JSON.stringify(maxBody)}`);
  }
});
test('the rendered CSP lets an application serve its own page', () => {
  const line = renderGateway(g).locations.split('\n').find(l => l.includes('Content-Security-Policy'));
  // Loading one's own script file, showing an image and running a worker is the
  // ordinary case for a published application; a policy missing these directives
  // blocks all three, which is how a working page turns into a blank one.
  for (const directive of ["script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "font-src 'self' data:", "worker-src 'self' blob:", 'object-src']) assert.ok(line.includes(directive), directive);
  // ...while the directives that keep a hosted page from escaping its own origin
  // stay in place.
  for (const directive of ["default-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(line.includes(directive), directive);
});
test('WSS wrapper preserves SSH pinning and rejects proxy command injection', () => {
  const args = sshArgs({ ...c, transportUrl: 'wss://artifact.example.cc/_gateway/tunnel' });
  assert.ok(args.some(x => x.startsWith('ProxyCommand=')));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  for (const transportUrl of ['ws://host/tunnel', "wss://host/tunnel'; evil", 'wss://host/%h']) assert.throws(() => sshArgs({ ...c, transportUrl }));
});
test('gateway denies shell, local forwards, passwords and root', () => {
  const r = renderGateway(g); for (const x of ['MaxSessions 0', 'PermitOpen none', 'AllowTcpForwarding remote', 'PermitRootLogin no', 'PasswordAuthentication no', 'GatewayPorts no']) assert.ok(r.sshd.includes(x));
  assert.ok(r.authorizedKeys.includes('permitlisten="127.0.0.1:28191"'));
  assert.ok(r.locations.includes('proxy_pass http://127.0.0.1:28191'));
  assert.ok(r.locations.includes('proxy_buffering off'));
  assert.ok(r.sshd.includes('ListenAddress 127.0.0.1'));
});
test('the tunnel admits as many connections per client as an application route', () => {
  // One client opens a tunnel per application it publishes, and the tunnel
  // location is a single route shared by all of them. A ceiling below the
  // application-route ceiling lets the tunnel run out first, so a client is
  // refused at the tunnel while its own application routes would still accept
  // it. Both are per-client (limit_conn_zone $binary_remote_addr), so they are
  // the same unit and must not disagree.
  //
  // The directives are rendered one per line, so a block runs from its opening
  // line to the closing brace.
  const lines = renderGateway(g).locations.split('\n');
  const blockOf = (header) => {
    const start = lines.findIndex(line => line.includes(header));
    assert.ok(start >= 0, `${header} must be rendered`);
    const end = lines.indexOf('}', start);
    assert.ok(end > start, `${header} must be a closed block`);
    return lines.slice(start, end + 1).join('\n');
  };
  const ceilingOf = (block) => block.match(/limit_conn cag_p0_connections (\d+);/)?.[1];
  const tunnel = ceilingOf(blockOf('location = /_gateway/tunnel'));
  const application = ceilingOf(blockOf('location ^~ /demo/'));
  assert.equal(tunnel, application);
  assert.equal(tunnel, '50');
});

test('bulk application traffic cannot starve the endpoints that open an application', () => {
  // Every application route and every control-plane route used to share one
  // per-client budget. An application loading its own assets therefore spent the
  // allowance the browser needed for the launch that followed it, and the launch
  // came back 503 — the application could not be opened at all. Measured against
  // production before the split: one page load issued ~44 concurrent asset
  // requests, and the launch immediately after was refused.
  //
  // The same applies to connections: limit_conn_zone is one counter per client
  // shared by every location, so a bulk route admitting more connections than a
  // control-plane route lets a client spend the allowance its own identity
  // request needs. Both budgets must therefore be split, not just the request one.
  const r = renderGateway({ ...g, controlPort: 22445 });

  const definedZones = (directive) => r.nginx.split('\n')
    .filter((line) => line.startsWith(directive))
    .map((line) => line.match(/zone=(\w+):/)?.[1])
    .filter(Boolean);
  const requestZones = definedZones('limit_req_zone');
  const connectionZones = definedZones('limit_conn_zone');
  assert.ok(requestZones.includes('cag_p0_requests'), 'the bulk request zone must be defined');
  assert.ok(requestZones.includes('cag_p0_control'), 'the control request zone must be defined');
  assert.ok(connectionZones.includes('cag_p0_connections'), 'the bulk connection zone must be defined');
  assert.ok(connectionZones.includes('cag_p0_control_connections'), 'the control connection zone must be defined');

  // Blocks are matched on the rendered text, so a single-line control-plane
  // location and a multi-line application route are read the same way.
  const blockOf = (header) => {
    const pattern = new RegExp(`${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`);
    const match = r.locations.match(pattern);
    assert.ok(match, `${header} must be rendered as a closed block`);
    return match[0];
  };
  const requestZoneOf = (block) => block.match(/limit_req zone=(\w+) burst=(\d+)/);
  const connectionZoneOf = (block) => block.match(/limit_conn (\w+) (\d+)/);

  // Every endpoint a browser must reach to open an application, and to stay
  // identified once it has: none of them may sit on the bulk budget.
  const controlLocations = [
    'location = /api/apps',
    'location = /_gateway/health',
    'location = /_gateway/me',
    'location = /_gateway/codes',
    'location ^~ /_gateway/apps',
    'location ^~ /_auth/',
    'location ^~ /_launch/',
  ];
  for (const header of controlLocations) {
    const block = blockOf(header);
    assert.equal(requestZoneOf(block)?.[1], 'cag_p0_control', `${header} must use the control request budget`);
    const connection = connectionZoneOf(block);
    if (connection) {
      assert.equal(connection[1], 'cag_p0_control_connections', `${header} must use the control connection budget`);
    }
  }

  // Bulk traffic keeps its own budget.
  const application = blockOf('location ^~ /demo/');
  assert.equal(requestZoneOf(application)?.[1], 'cag_p0_requests', 'application content must use the bulk request budget');
  assert.equal(connectionZoneOf(application)?.[1], 'cag_p0_connections', 'application content must use the bulk connection budget');

  // The tunnel carries an application's own transport, and its client is the bot
  // that published it — one bot publishing N applications opens N connections
  // from one address. It belongs to the bulk budget, not the control one.
  const tunnel = blockOf('location = /_gateway/tunnel');
  assert.equal(connectionZoneOf(tunnel)?.[1], 'cag_p0_connections', 'the tunnel must use the bulk connection budget');

  // A control-plane ceiling below the bulk one reintroduces the same starvation
  // in the connection dimension, so the control ceiling must not be the smaller.
  const applicationConnections = Number(connectionZoneOf(application)?.[2]);
  for (const header of controlLocations) {
    const connection = connectionZoneOf(blockOf(header));
    if (!connection) continue;
    assert.ok(Number(connection[2]) >= applicationConnections,
      `${header} must not admit fewer connections than a bulk route`);
  }

  // The bulk burst has to hold a real page load, not a token one.
  assert.ok(Number(requestZoneOf(application)?.[2]) >= 44, 'the bulk burst must hold a real page load');
});

test('reject duplicate routes and configuration injection', () => {
  assert.throws(() => renderGateway({ ...g, apps: [g.apps[0], g.apps[0]] }));
  assert.throws(() => renderGateway({ ...g, hostKey: '/etc/cert;evil' }));
  assert.throws(() => renderGateway({ ...g, apps: [g.apps[0], { ...g.apps[0], id: 'other', remotePort: 28192 }] }));
});

test('both domains expose identical root app paths, without preview dependency', () => {  const r = renderGateway(g);
  assert.ok(r.locations.includes('location ^~ /demo/'));
  assert.ok(r.locations.includes('location = /_gateway/tunnel'));
  for (const host of g.publicHosts) assert.ok(r.locations.includes(`https://${host}/demo/`));
  assert.ok(!r.locations.includes('_cag_p0'));
  for (const publicHosts of [[], ['a', 'a'], ['a;evil'], ['a\n']]) assert.throws(() => renderGateway({ ...g, publicHosts }));
});
