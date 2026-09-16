import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function port(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Expected an unprivileged TCP port');
  return value;
}
export function name(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) throw new Error('Invalid application/user name');
  return value;
}
export function validateConnector(c) {
  name(c.appId); name(c.user);
  if (typeof c.host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(c.host)) throw new Error('Invalid gateway hostname');
  for (const k of ['sshPort', 'remotePort', 'localPort']) port(c[k]);
  for (const k of ['identityFile', 'knownHostsFile', 'statusFile']) {
    if (typeof c[k] !== 'string' || !path.isAbsolute(c[k]) || /[\r\n\0]/.test(c[k])) throw new Error(`Invalid ${k}`);
  }
  if (c.transportUrl && !/^wss:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/[a-zA-Z0-9/_-]+$/.test(c.transportUrl)) throw new Error('Invalid WSS transport URL');
  return c;
}
export function sshArgs(input) {
  const c = validateConnector(input);
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  const proxy = c.transportUrl ? ['-o', `ProxyCommand=${[process.execPath, fileURLToPath(new URL('./ws-proxy.mjs', import.meta.url)), c.transportUrl].map(quote).join(' ')}`] : [];
  return ['-F', '/dev/null', '-v', '-N', '-T', ...proxy, '-p', String(c.sshPort),
    '-i', c.identityFile,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsFile}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForwardAgent=no',
    '-R', `127.0.0.1:${c.remotePort}:127.0.0.1:${c.localPort}`, `${c.user}@${c.host}`];
}
