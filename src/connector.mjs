import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { validateConnector, sshArgs } from './config.mjs';

const config = validateConnector(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
const lock = `${config.statusFile}.lock`;
// OS service manager is the production owner; this also rejects accidental concurrent CLI launches.
try { fs.mkdirSync(lock, { mode: 0o700 }); }
catch {
  const pid = Number(fs.readFileSync(`${lock}/pid`, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid connector lock; inspect manually');
  let gone = false;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') gone = true; }
  if (!gone) throw new Error('Connector already running or PID reused; inspect lock owner');
  fs.unlinkSync(`${lock}/pid`); fs.rmdirSync(lock);
  fs.mkdirSync(lock, { mode: 0o700 });
}
fs.writeFileSync(`${lock}/pid`, String(process.pid), { mode: 0o600 });
let child, timer, stopping = false, attempt = 0;
function status(state, error = null) {
  const tmp = `${config.statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ appId: config.appId, state, attempt, updatedAt: new Date().toISOString(), error }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, config.statusFile);
  console.log(JSON.stringify({ appId: config.appId, state, attempt, error }));
}
function release() { fs.rmSync(`${lock}/pid`, { force: true }); fs.rmdirSync(lock); }
function stop() {
  if (stopping) return;
  stopping = true; clearTimeout(timer);
  status('stopping');
  if (child) { child.kill('SIGTERM'); setTimeout(() => child?.kill('SIGKILL'), 4000).unref(); }
  else { status('stopped'); release(); }
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
function connect() {
  if (stopping) return;
  attempt++; status('connecting');
  let fatal = null, buffer = '', connectedAt = 0;
  child = spawn('ssh', sshArgs(config), { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => {
    buffer = (buffer + data).slice(-16000);
    if (!connectedAt && /remote forward success|remote forward .*success/.test(buffer)) { connectedAt = Date.now(); status('connected'); }
    if (/Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|remote port forwarding failed/i.test(buffer)) fatal = 'authentication_host_key_or_port_binding_failed';
  });
  child.on('error', () => { fatal = 'ssh_process_unavailable'; });
  child.on('close', () => {
    child = null;
    if (stopping) { status('stopped'); release(); return; }
    if (fatal) { status('blocked', fatal); release(); process.exitCode = 78; return; }
    if (connectedAt && Date.now() - connectedAt > 60000) attempt = 0;
    status('retrying', 'transport_disconnected');
    timer = setTimeout(connect, [2000, 5000, 15000, 30000][Math.min(Math.max(attempt - 1, 0), 3)]);
  });
}
connect();
