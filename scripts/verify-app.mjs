#!/usr/bin/env node
// Acceptance check for one published Artifact application.
//
// Answers the four questions someone actually has right after publishing:
// is the route live on every public domain, does the identity endpoint answer
// honestly instead of failing, does a credential really resolve to a user, and
// is the signed-in answer distinguishable from the guest answer (which is what
// makes per-viewer pages possible at all).
//
// Exit code is non-zero when any check fails, so this can run in automation.
import process from 'node:process';

const CONTRACT = 'catsco.artifact-viewer.v1';
const DEFAULT_HOSTS = ['artifact.catsco.cc', 'artifact.catsco.cn'];

// Single-pass parsing on purpose: a credential value contains spaces and a
// header name that does not start with a dash, so a positional-scan shortcut
// would happily mistake it for the application id.
const argv = process.argv.slice(2);
const options = { hosts: [], credential: null, json: false };
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--host') options.hosts.push(argv[(i += 1)]);
  else if (arg === '--credential') options.credential = argv[(i += 1)] ?? '';
  else if (arg === '--json') options.json = true;
  else if (arg.startsWith('--')) { console.error(`Unknown option ${arg}`); process.exit(2); }
  else positional.push(arg);
}
const [appId] = positional;
if (!appId || !/^[a-z][a-z0-9_-]{0,47}$/.test(appId)) {
  console.error('Usage: verify-app.mjs APP_ID [--host HOST]... [--credential "Cookie: …"] [--json]');
  console.error('  --credential  a raw Cookie or Authorization header to test the signed-in path');
  process.exit(2);
}
const { credential, json } = options;
const hosts = options.hosts.length ? options.hosts : [...DEFAULT_HOSTS];

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const request = async (url, headers = {}) => {
  try {
    const res = await fetch(url, { headers, redirect: 'manual' });
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* a route check only needs the status */ }
    return { status: res.status, body: parsed };
  } catch (error) {
    // Deliberately no error.message: a transport failure can quote the request
    // headers, and one of them is the caller's credential.
    return { status: 0, body: null, error: error?.name || 'error' };
  }
};

// 1. The route itself, on every public domain. Both are the same deployment, so
//    a wrong one still answers — which is why this checks all of them instead of
//    trusting the first.
for (const host of hosts) {
  const res = await request(`https://${host}/${appId}/`);
  check(`route on ${host}`, res.status > 0 && res.status < 400, res.status ? `HTTP ${res.status}` : `no response (${res.error})`);
}

const base = `https://${hosts[0]}`;
const me = async headers => (await request(`${base}/_gateway/me?app=${appId}`, headers)).body;

// 2. The identity endpoint, without a credential: it must answer a guest, not an
//    error. A broken identity service and a real guest are different states, and
//    an application cannot tell them apart if this call fails.
const guest = await me({});
check('identity endpoint answers', guest?.contract === CONTRACT, guest ? `contract ${guest.contract ?? '(missing)'}` : 'no JSON body');
check('guest is reported as guest', guest?.authenticated === false && guest?.viewer === null, JSON.stringify(guest?.viewer ?? null));
check('guest names the application', !guest?.app_id || guest.app_id === appId, String(guest?.app_id));

// 3. The signed-in path. Only meaningful with a credential, so it is skipped
//    rather than faked when none is given.
if (credential) {
  const user = await me({ Cookie: credential });
  const viewer = user?.viewer ?? null;
  check('credential resolves to a user', user?.authenticated === true, JSON.stringify(user?.authenticated));
  check('viewer carries a pseudonym', /^ap_[A-Za-z0-9_-]{22}$/.test(String(viewer?.id ?? '')), String(viewer?.id));
  check('viewer carries an account identity', viewer?.uid !== null && viewer?.uid !== undefined || typeof viewer?.username === 'string', `uid=${JSON.stringify(viewer?.uid)} username=${JSON.stringify(viewer?.username)}`);
  // The whole point of the identity path: the two states must be distinguishable,
  // otherwise an application has nothing to branch on for per-viewer content.
  check('signed-in differs from guest', user?.authenticated === true && guest?.authenticated === false, 'distinguishable');
  check('same application on both paths', user?.app_id === appId, String(user?.app_id));
} else {
  results.push({ name: 'signed-in path', ok: null, detail: 'skipped (pass --credential to test it)' });
}

const failed = results.filter(r => r.ok === false);
if (json) {
  console.log(JSON.stringify({ appId, hosts, results, ok: failed.length === 0 }, null, 2));
} else {
  console.log(`Artifact acceptance: ${appId}  (${hosts.join(', ')})`);
  for (const r of results) {
    console.log(`  ${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(failed.length === 0 ? '\nAll checks passed.' : `\n${failed.length} check(s) failed.`);
}
process.exit(failed.length === 0 ? 0 : 1);
