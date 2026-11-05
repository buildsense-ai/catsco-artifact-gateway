import net from 'node:net';
import { port } from './config.mjs';
import { identityVerdict, readApplicationIdentity } from './app-identity.mjs';

// Removing an authorized key does not close an authenticated SSH session. Keep
// its forwarding port retired across restarts, even after the listener goes
// away: an old session may still be alive and request the forward again.
export function retiredRemotePorts(config) {
  const values = config.retiredRemotePorts === undefined ? [] : config.retiredRemotePorts;
  if (!Array.isArray(values)) throw new Error('Invalid retiredRemotePorts');
  return new Set(values.map(port));
}

export function retireRemotePort(config, remotePort) {
  const retired = retiredRemotePorts(config);
  retired.add(port(remotePort));
  return { ...config, retiredRemotePorts: [...retired].sort((a, b) => a - b) };
}

// Bind instead of making an HTTP request: a dead tunnel or a non-HTTP listener
// still owns the port. This also catches orphaned tunnels from before retirement
// records existed. Only EADDRINUSE means "try the next port"; other failures must
// stop publication rather than guess that a socket is free.
export function remotePortAvailable(remotePort) {
  port(remotePort);
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port: remotePort, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolve(true));
    });
  });
}

export async function allocateRemotePort(config, { base, ceiling, reserved, available = remotePortAvailable }) {
  const used = new Set([...reserved, ...retiredRemotePorts(config)]);
  for (const app of config.apps || []) used.add(app.remotePort);
  for (let candidate = base; candidate <= ceiling; candidate++) {
    if (!used.has(candidate) && await available(candidate)) return candidate;
  }
  return null;
}

// What the port an application already holds is actually serving.
//
//   idle       nothing answers, or what answers is not HTTP. The tunnel is down;
//              nobody else is using the port, so the lease stands.
//   ours       the port answers as this application.
//   foreign    the port answers as a DIFFERENT application.
//   unclaimed  the port answers but makes no claim, so there is nothing to compare.
//
// `unclaimed` and `idle` are not failures. Most of the fleet predates the
// identity contract, and a stopped connector cannot say anything at all. Only
// `foreign` is positive evidence that the port no longer belongs here, and only
// it justifies moving an application to a new port.
export const LEASE = Object.freeze({
  IDLE: 'idle',
  OURS: 'ours',
  FOREIGN: 'foreign',
  UNCLAIMED: 'unclaimed',
});

export async function inspectLease(remotePort, { appId, readIdentity = readApplicationIdentity } = {}) {
  port(remotePort);
  const claim = await readIdentity(remotePort);
  if (claim?.state === 'unusable') return LEASE.IDLE;
  if (claim?.state !== 'claimed') return LEASE.UNCLAIMED;
  // Nothing to compare against: say so rather than guess. A caller that forgot
  // the id must not be able to move an application off a working port.
  if (typeof appId !== 'string' || !appId.trim()) return LEASE.UNCLAIMED;
  return identityVerdict(claim, appId) === 'other' ? LEASE.FOREIGN : LEASE.OURS;
}
