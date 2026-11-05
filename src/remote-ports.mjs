import net from 'node:net';
import { port } from './config.mjs';

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
