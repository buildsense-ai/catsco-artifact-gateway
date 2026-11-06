import http from 'node:http';

import { identityVerdict, readApplicationIdentity } from './app-identity.mjs';

// How the sidebar learns whether an application can actually be opened.
//
// The list used to answer a constant 'ready', which made every failure look the
// same: a stopped application, a connector that never came back after a reboot,
// and a healthy application were indistinguishable from the list. The two checks
// below separate the three cases with no protocol change and nothing asked of the
// connector, because the tunnel's forwarding socket is the whole story:
//
//   not listening        the tunnel is down (connector stopped, or never connected)
//   listening, no answer the tunnel is up but nothing serves the local port
//   listening, answered  both ends are up (any HTTP status counts, including 401)
//
// A probe therefore never decides whether an application is *correct*, only
// whether it is reachable — an application that answers 500 is reachable.
//
// The timeout is set against what the deployment itself tolerates, not against
// what feels fast. nginx allows an application 3s to accept the connection and
// 65s to answer, so a healthy application may legitimately take seconds to
// respond. Probing with a tighter budget than the one users are served under
// would report a working application as offline — the opposite of the problem
// this field exists to fix. It therefore matches the connect budget, and the
// probe's own request is a plain GET that the deployment answers within it.
// The only values `status` may take. One place, because the field crosses the
// gateway, the platform and the sidebar, and three of those used to spell the
// same three strings out separately.
//
//   online    reachable, and — when the port makes a claim — the claim is ours
//   offline   not reachable
//   unknown   the probe did not answer within the budget; nothing was established
//   mismatch  reachable, but the port says it is a DIFFERENT application
//
// `mismatch` is the one that did not exist before, and the reason it had to be
// added: a port that serves somebody else's content answers 200, so every check
// the gateway had called it reachable. Nothing anywhere compared what answered
// against what was supposed to answer.
export const APP_STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
  MISMATCH: 'mismatch',
});

const PROBE_TIMEOUT_MS = 3000;
// The whole list shares one deadline, on top of the per-application timeout. With
// a per-application budget alone, one unresponsive application per batch stretches
// the request to a multiple of the timeout (ten such applications take two batches,
// so six seconds), and this list is fetched by every sidebar refresh. Whatever the
// deadline cuts off is reported as unknown rather than offline: the probe did not
// answer, which is not the same as the application being down.
const PROBE_BUDGET_MS = 4000;
// One probe per application per window. The list is fetched by every sidebar
// refresh and by the platform, so probing on every request would multiply a
// cheap read into a fan-out of outbound connections.
const PROBE_CACHE_MS = 10_000;
const PROBE_CONCURRENCY = 8;
// The identity pass gets a slice, not the whole list deadline. It is a refinement
// of the reachability answer, so it may fall behind without costing the caller
// anything: whatever it does not settle keeps the reachability status, and its
// verdict is picked up by the next request.
const IDENTITY_BUDGET_MS = 250;
// Longer than reachability on purpose. A verdict only changes when an application
// is republished or a port starts answering as somebody else, and re-asking a
// static document on every ten-second refresh would spend connections for nothing.
const IDENTITY_CACHE_MS = 60_000;
// Identity is one small file per application, so it can run wider than the
// reachability gate without competing with it.
const IDENTITY_CONCURRENCY = 8;

// One application's reachability. Never rejects: an unreachable application is
// an answer, not an error.
//
// Only the response line matters, so the socket is destroyed as soon as headers
// arrive. Draining the body instead would not be enough: `resume()` reads until
// the response ends, and an application that streams — SSE, a progress feed, a
// page that never finishes — keeps the connection open indefinitely. Each probe
// would then leave a socket behind until the process runs out of file
// descriptors, and every later probe would fail with EMFILE and report healthy
// applications as offline.
//
// The deadline is a wall clock, not `http.request`'s `timeout` option. That
// option is an *idle* timer: any byte on the socket resets it, so an application
// that trickles — a byte every few seconds, or a response line that never
// completes — keeps a probe pending forever. A pending probe holds a slot in the
// concurrency gate, and enough of them stop every other application from being
// probed at all.
//
// This answers "is anything there", and deliberately nothing else. Who answers
// is a second question with its own budget, asked by the probe coordinator below
// so that a slow identity answer can never delay the reachability of the list.
export function probeApplication(remotePort, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let deadline = null;
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.destroy();
      resolve(status);
    };
    const request = http.request(
      { host: '127.0.0.1', port: remotePort, path: '/', method: 'GET' },
      () => finish(APP_STATUS.ONLINE),
    );
    deadline = setTimeout(() => finish(APP_STATUS.OFFLINE), timeoutMs);
    request.on('error', () => finish(APP_STATUS.OFFLINE));
    request.end();
  });
}

// Probes the requested applications and answers a map of id -> status.
//
// The cache is keyed per *target* — an application id paired with the port that
// is probed for it — not per request and not per set of applications. Keying by
// the caller's set would let the caller drive the probing: `?agent=` decides the
// set, it is a public query parameter, and alternating two agent ids would miss
// the cache every time and re-probe both sets in full, request after request.
// Per-target entries make the guarantee independent of who asks and of how they
// order or group their applications: a target is probed at most once per window
// no matter how many callers want it, and adding or removing one application
// costs one probe rather than a full round.
//
// The key carries the port because the port is what is probed. An application
// that was removed and published again gets a new forwarding port, and answering
// its id from the old port's entry would report reachability for a socket nobody
// checked.
//
// Identity is a separate pass with its own concurrency and its own budget, and
// it asks only about ports that answered. Two reasons, both learned the hard way:
//
//   - Sharing the reachability gate would let a slow identity document hold a
//     slot that the reachability probe used to release at the response line, so
//     141 applications would push each other past the whole-list deadline and
//     every entry would come back `unknown`.
//   - A port nobody answers on cannot be serving somebody else, so asking it is
//     spending the budget on a question that is already settled.
//
// The identity pass is capped by a deadline of its own and never fails the list.
// Verdicts are cached on a longer window than reachability, so steady state pays
// nothing and only newly seen targets cost a round trip.
export function createStatusProbe({
  cacheMs = PROBE_CACHE_MS,
  concurrency = PROBE_CONCURRENCY,
  budgetMs = PROBE_BUDGET_MS,
  probe = probeApplication,
  identity = readApplicationIdentity,
  identityBudgetMs = IDENTITY_BUDGET_MS,
  identityCacheMs = IDENTITY_CACHE_MS,
  identityConcurrency = IDENTITY_CONCURRENCY,
} = {}) {
  // 'id:port' -> { status, at }
  const entries = new Map();
  // 'id:port' -> promise, so concurrent callers wanting the same target share one
  // probe instead of racing to open two connections to the same port.
  const inFlight = new Map();
  // 'id:port' -> { verdict, at }. Only conclusive answers are stored: an
  // unanswered document is retried on the next request rather than remembered as
  // "fine", because "fine" is exactly what it is not.
  const verdicts = new Map();
  const verdictInFlight = new Map();
  // A single gate for the whole probe, not one per request: the point is to bound
  // outbound connections from this process, and per-request limits multiply by the
  // number of concurrent requests. Identity gets its own gate for the same reason
  // it gets its own budget.

  // A counting gate, owned per purpose.
  //
  // The count is the only state on purpose. An earlier version also kept a
  // `held` flag per gate and consulted it in `release`; because one gate serves
  // many concurrent holders, the first release cleared the flag and every other
  // holder's release then returned early without decrementing. The count only
  // ever went up, so after the first batch the probe ran one application at a
  // time — the same whole-list timeout the split into two passes was meant to
  // avoid, arrived at by a different route, and permanently.
  function createGate(limit) {
    let active = 0;
    const waiter = [];
    return {
      async acquire() {
        if (active < limit) { active += 1; return; }
        // The releaser hands over its slot by incrementing before waking us, so
        // the resumed caller already holds one and must not take another.
        await new Promise(resolve => waiter.push(resolve));
      },
      release() {
        active -= 1;
        const next = waiter.shift();
        if (next) { active += 1; next(); }
      },
    };
  }

  const reachGate = createGate(concurrency);
  const identityGate = createGate(identityConcurrency);

  async function acquire() { await reachGate.acquire(); }
  function release() { reachGate.release(); }
  async function acquireIdentity() { await identityGate.acquire(); }
  function releaseIdentity() { identityGate.release(); }

  function targetsOf(apps) {
    const seen = new Set();
    const targets = [];
    for (const app of apps) {
      if (!Number.isInteger(app?.remotePort) || typeof app?.id !== 'string') continue;
      const key = `${app.id}:${app.remotePort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ id: app.id, key, port: app.remotePort });
    }
    return targets;
  }

  function probeTarget({ key, port }) {
    const running = inFlight.get(key);
    if (running) return running;
    // A probe that throws has established nothing and must not turn the list into
    // a failure. The default probe already answers rather than throwing, but the
    // seam is injectable, so the guarantee belongs here.
    const run = (async () => {
      await acquire();
      try {
        return await probe(port);
      } catch {
        return APP_STATUS.OFFLINE;
      } finally {
        release();
      }
    })();
    inFlight.set(key, run);
    // The entry is written by whoever ran the probe, so a later caller inside the
    // window reads the answer instead of probing again.
    run.then(status => entries.set(key, { status, at: Date.now() }))
      .finally(() => inFlight.delete(key));
    return run;
  }

  // What the port claims to be, from cache when it is fresh.
  //
  // Cached: a claim naming an application (own / other), and a complete answer
  // that names none ('absent' — the port says it has no identity document).
  // Both are facts about the application, and both are expensive to re-establish
  // for the whole fleet on every sidebar refresh.
  //
  // Not cached: 'unusable' — nothing answered, or the answer was cut short. That
  // is a fact about the moment, not about the application, so the next refresh
  // asks again. Caching it would silently skip the check for an application whose
  // document was merely slow once.
  function verdictOf(target, now) {
    const cached = verdicts.get(target.key);
    if (cached && now - cached.at < identityCacheMs) return Promise.resolve(cached.verdict);
    const running = verdictInFlight.get(target.key);
    if (running) return running;
    const run = (async () => {
      await acquireIdentity();
      try {
        const claim = await identity(target.port);
        const verdict = identityVerdict(claim, target.id);
        // Only a settled answer is remembered: a claim that names an application,
        // or a complete answer that names none. Named as a whitelist on purpose —
        // "everything except unusable" would silently start caching the next state
        // anyone adds, and the cache is the one place where a wrong assumption
        // hides a check for a full window. An application that adopts the contract
        // later is picked up within one window.
        if (claim?.state === 'claimed' || claim?.state === 'absent') {
          verdicts.set(target.key, { verdict, at: Date.now() });
        }
        return verdict;
      } catch {
        // An identity read that throws says nothing about the application, so it
        // must never be able to turn a reachable application into a failure.
        return 'unknown';
      } finally {
        releaseIdentity();
      }
    })();
    verdictInFlight.set(target.key, run);
    run.finally(() => verdictInFlight.delete(target.key));
    return run;
  }

  async function probeAll(apps, now = Date.now()) {
    const statuses = new Map();
    const missing = [];
    const targets = targetsOf(apps);
    for (const target of targets) {
      const entry = entries.get(target.key);
      if (entry && now - entry.at < cacheMs) statuses.set(target.id, entry.status);
      else missing.push(target);
    }
    if (missing.length) {
      // The budget is applied to the wait, not to the probe: a probe that is
      // already running still records its answer for the next caller, but nobody
      // waits past the deadline. Targets left unanswered are 'unknown' — the
      // honest answer when nothing was established, and distinct from 'offline'.
      //
      // The probes write into a private map and the result is filled in once,
      // after the race. Writing into the returned map from the background probes
      // would let it keep changing after the caller already has it.
      const answers = new Map();
      const settled = Promise.all(missing.map(async target => {
        answers.set(target.id, await probeTarget(target));
      }));
      let timer = null;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, budgetMs); });
      await Promise.race([settled, deadline]);
      clearTimeout(timer);
      for (const target of missing) {
        statuses.set(target.id, answers.has(target.id) ? answers.get(target.id) : APP_STATUS.UNKNOWN);
      }
    }

    // Ask who answers, but only where something answered, and only for as long as
    // the identity budget allows. Whatever does not settle in time keeps the
    // reachability answer: the list is a reachability list first, and an identity
    // answer that arrives late is still useful on the next request.
    const online = targets.filter(target => statuses.get(target.id) === APP_STATUS.ONLINE);
    if (online.length) {
      const settledVerdicts = new Map();
      const settled = Promise.all(online.map(async target => {
        settledVerdicts.set(target.id, await verdictOf(target, now));
      }));
      let timer = null;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, identityBudgetMs); });
      await Promise.race([settled, deadline]);
      clearTimeout(timer);
      for (const target of online) {
        if (settledVerdicts.get(target.id) === 'other') statuses.set(target.id, APP_STATUS.MISMATCH);
      }
    }
    return statuses;
  }

  return { probeAll };
}
