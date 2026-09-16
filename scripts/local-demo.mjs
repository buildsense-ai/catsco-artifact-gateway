// Optional non-root P0 launcher. Production may use an existing supervisor instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const [action, configPath] = process.argv.slice(2);
const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dir = path.dirname(path.resolve(configPath));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = path.join(dir, 'demo-processes.json');
const stamp = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; } };
const old = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : [];
if (action === 'status') {
  console.log(JSON.stringify(old.map(p => ({ ...p, running: stamp(p.pid) === p.started }))));
} else if (action === 'stop') {
  for (const p of old) if (stamp(p.pid) === p.started) process.kill(p.pid, 'SIGTERM');
  console.log(JSON.stringify({ requested: 'stop', processes: old.length }));
} else if (action === 'start') {
  if (old.some(p => stamp(p.pid) === p.started)) throw new Error('Existing demo processes; stop before start');
  const log = fs.openSync(path.join(dir, 'demo-runtime.log'), 'a', 0o600);
  const entries = [['app', 'demo/server.mjs', []], ['connector', 'src/connector.mjs', [path.resolve(configPath)]]];
  const processes = [];
  try {
    for (const [role, script, args] of entries) {
      const p = spawn(process.execPath, [path.join(root, script), ...args], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: { ...process.env, APP_ID: c.appId, PORT: String(c.localPort), DATA_DIR: path.join(dir, 'data') } });
      await new Promise((resolve, reject) => { p.once('spawn', resolve); p.once('error', reject); });
      processes.push({ role, pid: p.pid, started: stamp(p.pid) }); p.unref();
    }
    fs.writeFileSync(registry, JSON.stringify(processes), { mode: 0o600 });
    console.log(JSON.stringify({ uid: process.getuid?.(), processes }));
  } finally { fs.closeSync(log); }
} else throw new Error('Usage: local-demo start|stop|status CONFIG');
