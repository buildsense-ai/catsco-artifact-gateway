import http from 'node:http';

// The contract an application answers with when asked who it is, and where it
// answers. One document, one question: "which application is this port serving?"
//
// Why this exists at all: a port number is the only identity a request carries,
// and a port number is a shared resource. It says where traffic goes, never who
// answers. Everything else that could be compared has been measured against the
// live inventory and rejected — page titles differ from registered names for 49
// of 141 applications (renaming is normal), and content hashes cannot be read at
// all for the applications that stream or refuse the probe.
//
// The document is deliberately static. A dynamic application still answers it,
// because the answer is not derived from the page it is serving.
export const APP_IDENTITY_CONTRACT = 'catsco.artifact-identity.v1';
export const APP_IDENTITY_PATH = '/.well-known/catsco-app.json';

// A claim is a few dozen bytes. Anything larger is not the document, and reading
// it would be the unbounded read the reachability probe exists to avoid.
const IDENTITY_MAX_BYTES = 8 * 1024;
// Short on purpose: this runs before the reachability probe, and an application
// that does not serve the document should cost a 404, not a full timeout. A
// deployment answers a static file immediately, so a slow answer is a no.
const IDENTITY_TIMEOUT_MS = 800;

// What a port claims to be.
//
//   claimed   the document is there and names an application
//   absent    no document (404, not JSON, wrong contract, unreadable)
//   unusable  nothing answered, or the answer was too slow
//
// `absent` and `unusable` are both "no claim was made". They are kept apart
// because they mean different things to an operator: absent is an application
// that has not adopted the contract, unusable is a port that is not talking.
export function readApplicationIdentity(remotePort, {
  timeoutMs = IDENTITY_TIMEOUT_MS,
  maxBytes = IDENTITY_MAX_BYTES,
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    let deadline = null;
    let request = null;
    let body = '';
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve(value);
    };
    request = http.request(
      { host: '127.0.0.1', port: remotePort, path: APP_IDENTITY_PATH, method: 'GET' },
      response => {
        // Only a complete 200 can be a claim. A redirect, an error page and a
        // missing route are all "this port does not speak the contract".
        if (response.statusCode !== 200) {
          response.resume();
          finish({ state: 'absent' });
          return;
        }
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          // Crossed the size of a legitimate claim: stop reading rather than let
          // an application decide how much of the probe's budget it spends.
          if (body.length > maxBytes) finish({ state: 'absent' });
        });
        response.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { finish({ state: 'absent' }); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish({ state: 'absent' });
            return;
          }
          if (parsed.contract !== APP_IDENTITY_CONTRACT) { finish({ state: 'absent' }); return; }
          const appId = typeof parsed.app_id === 'string' ? parsed.app_id.trim() : '';
          if (!appId) { finish({ state: 'absent' }); return; }
          finish({ state: 'claimed', appId });
        });
        // A body cut short by the deadline is not a claim either.
        response.on('error', () => finish({ state: 'absent' }));
      },
    );
    // Wall clock, not `timeout`: a body that trickles a byte at a time would
    // otherwise hold this probe until the process runs out of sockets.
    deadline = setTimeout(() => finish({ state: 'unusable' }), timeoutMs);
    request.on('error', () => finish({ state: 'unusable' }));
    request.end();
  });
}

// Whether a claim settles the question for one application.
//
// Only a named, different application counts. A port that makes no claim is not
// evidence of anything — most of the fleet predates the contract — so it must
// never be reported as a mismatch. That asymmetry is what keeps this truthful:
// it fires only when the port positively says it is somebody else.
export function identityVerdict(claim, appId) {
  if (!claim || claim.state !== 'claimed') return 'unknown';
  // Without an id there is nothing to compare against. Returning 'other' here
  // would let a missing argument alone declare the port foreign and move a
  // working application, so an absent subject answers "unknown" instead.
  if (typeof appId !== 'string' || !appId.trim()) return 'unknown';
  return claim.appId === appId ? 'own' : 'other';
}
