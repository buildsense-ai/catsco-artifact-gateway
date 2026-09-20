// Control plane for the light Artifact gateway.
//
// It owns exactly two things the tunnel cannot: the public application list and
// the one-shot identity exchange. Applications never see a key and never parse
// a ticket; they forward the credential to `/_gateway/me` and read the result.
import http from 'node:http';
import fs from 'node:fs';
import { appId, COOKIE_NAME, isToken, ViewerStore, VIEWER_CONTRACT, viewerIdentity } from './viewer-store.mjs';
import { cookieName, httpsUrl, port } from './config.mjs';
// Registration validates a candidate config with the very renderer the
// deployment uses, so a registration that would break sshd or nginx fails here
// instead of at the next apply.
import { renderGateway } from './gateway-config.mjs';

// Default platform handshake page. It must be the file the platform actually
// serves: the single-page app owns every extension-less path, so a bare
// `/artifact-auth` renders the app itself and the whole exchange silently
// becomes a no-op. The path-derived guard test below pins this.
export const DEFAULT_HANDSHAKE_URL = 'https://app.catsco.cc/artifact-auth.html';

const MAX_BODY = 8 * 1024;
const PLATFORM_IDENTITY_URL = 'https://app.catsco.cc/api/artifacts/identity';
const PLATFORM_COOKIE_NAME = 'catsco_artifact_id';
const PLATFORM_TIMEOUT_MS = 3000;
// A platform cookie is an opaque `<uid:exp.hmac>` blob; this is a sanity bound,
// not a parse. The gateway never reads a field out of it.
const MAX_PLATFORM_COOKIE = 4096;

// Remote ports are assigned by the gateway, never taken from a caller, so a new
// application can collide neither with the fixed gateway ports nor with a
// tunnel that is already up. The base sits above sshPort (22443), the WSS
// adapter (22444), the control plane (22445) and the two ports the deployed
// gateway already registered (28191, 28192), which makes the first assignment
// predictable: 28201.
const REMOTE_PORT_BASE = 28201;
const REMOTE_PORT_CEILING = 65535;
// Fixed by the rendered nginx include (`proxy_pass http://127.0.0.1:22444`), so
// it is reserved here as a constant instead of being read from the config.
const WSS_PORT = 22444;
// The same rule the connector applies to its own tunnel endpoint
// (`validateConnector` in config.mjs). Repeated rather than shared because this
// direction is the gateway publishing an endpoint to bots, not accepting one.
const TRANSPORT_URL_PATTERN = /^wss:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/[a-zA-Z0-9/_-]+$/;

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// The application id comes from an explicit query parameter or the referring
// application path. It is always checked against the ticket record, so a token
// minted for one application cannot be replayed against another sharing the
// same origin.
export function appFromRequest(req, url) {
  const explicit = url.searchParams.get('app');
  if (explicit) return appId(explicit);
  const referer = req.headers.referer;
  if (typeof referer === 'string') {
    try {
      const match = /^\/([a-z][a-z0-9_-]{0,47})(?:\/|$)/.exec(new URL(referer).pathname);
      if (match) return appId(match[1]);
    } catch { /* ignore malformed referer */ }
  }
  return null;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,128})$/.exec(header.trim());
  return match ? match[1] : null;
}

function cookieToken(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return isToken(token) ? token : null;
}

// The platform domain cookie (Domain=.catsco.cc) is the silent path: the browser
// sends it to the application host too, so the gateway can identify a visitor
// without a one-shot code ever being minted. Its value is opaque here.
function platformCookieValue(req, name) {
  const value = parseCookies(req.headers.cookie)[name];
  if (typeof value !== 'string' || value === '' || value.length > MAX_PLATFORM_COOKIE) return null;
  if (/[\r\n\0]/.test(value)) return null;
  return value;
}

// Ask the platform whether a domain cookie still identifies a signed-in user.
// Returns { uid, expiresAt } only when the platform vouches for it. Every other
// outcome (rejection, transport error, timeout, unreadable body) is a refusal,
// because the caller's only remaining option is the guest record: a broken or
// slow platform must never turn into a failed request.
async function verifyPlatformIdentity({ url, name, value, controlToken, timeoutMs, fetchImpl = globalThis.fetch, logger = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Cookie: `${name}=${value}`,
        Authorization: `Bearer ${controlToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'error',
    });
    if (res.status !== 200) return null;
    const body = await res.json();
    if (!body || body.authenticated !== true) return null;
    // The platform is the authority on its own uid, so this is the boundary
    // that insists on the shape: anything a real platform would never send is a
    // refusal (and therefore a guest), not a subject we quietly mint from.
    const uid = typeof body.uid === 'number' ? String(body.uid) : body.uid;
    if (typeof uid !== 'string' || !/^[0-9]{1,19}$/.test(uid)) return null;
    return {
      uid,
      username: typeof body.username === 'string' && body.username ? body.username : null,
      expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    };
  } catch (error) {
    // Deliberately no error.message: a transport error can quote the request
    // headers, and one of them is the visitor's platform cookie.
    logger?.error?.(JSON.stringify({ event: 'platform_identity_check_failed', reason: error?.name === 'AbortError' ? 'timeout' : 'error' }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The automatic identity attempt lands back on the application. Only paths
// inside the application that started it are allowed, so the handshake cannot
// be turned into an open redirect.
export function safeNext(value, app) {
  const fallback = `/${app}/`;
  if (typeof value !== 'string' || value.length > 512) return fallback;
  if (value !== `/${app}` && !value.startsWith(`/${app}/`)) return fallback;
  if (/[\r\n\0\\]/.test(value) || value.includes('//') || value.includes('..')) return fallback;
  return value;
}

export function handshakeTarget(handshakeUrl, app, next, gatewayOrigin) {
  const target = new URL(handshakeUrl);
  target.searchParams.set('app', app);
  target.searchParams.set('next', next);
  target.searchParams.set('gw', gatewayOrigin);
  return target.toString();
}

// How many trailing labels two hostnames share. `app.catsco.cn` and
// `artifact.catsco.cn` share two, which is the smallest useful match: it ties a
// platform origin to its gateway origin without treating every `.com` host as
// related. Anything shorter would make unrelated sites look like one site, and a
// shared site is exactly what keeps the visitor's cookies working.
function sharedTail(a, b) {
  const left = a.split('.').reverse();
  const right = b.split('.').reverse();
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return shared;
}

function hostOf(value) {
  if (typeof value !== 'string' || !value) return '';
  const text = value.includes('://') ? (() => { try { return new URL(value).hostname; } catch { return ''; } })() : value;
  const host = text.trim().toLowerCase().split(':')[0];
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return '';
  return host;
}

// Pick the entry that shares the caller's site, so the browser stays on the
// domain it is already signed in to. The two domains are the same deployment, so
// a wrong but reachable choice does not fail loudly — it silently drops the
// visitor to a guest. That is why the fallback only ever covers a hint that
// matches nothing (an older platform, or a deployment with one host configured);
// it is never a first choice.
export function matchBySuffix(entries, hint, hostOfEntry = hostOf) {
  const list = (Array.isArray(entries) ? entries : []).filter(entry => typeof entry === 'string' && entry);
  if (list.length === 0) return null;
  const wanted = hostOf(hint);
  if (!wanted) return list[0];
  let best = null;
  for (const entry of list) {
    const host = hostOfEntry(entry);
    if (!host) continue;
    if (host === wanted) return entry;
    const shared = sharedTail(wanted, host);
    if (shared >= 2 && (!best || shared > best.shared)) best = { entry, shared };
  }
  return best ? best.entry : list[0];
}

// The host the browser actually used, so the handshake returns the visitor to
// the same domain instead of always the first configured one. The answer is
// always an entry of `hosts`: the request header must never be echoed back.
function gatewayOrigin(req, hosts) {
  return `https://${matchBySuffix(hosts, req.headers.host)}`;
}

function choicePage(app, next) {
  const retry = `/_auth/start?app=${app}&next=${encodeURIComponent(next)}`;
  const guest = `${next}${next.includes('?') ? '&' : '?'}identity=guest`;
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要身份确认</title>
<style>body{margin:0;background:#0f1115;color:#e8ecf3;font:16px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:520px;margin:12vh auto;padding:28px;background:#171a21;border:1px solid #2a2f3a;border-radius:12px}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa4b2;margin:0 0 18px}
a{display:block;padding:12px 16px;border-radius:9px;text-decoration:none;margin:8px 0;text-align:center}
a.primary{background:#1f6feb;color:#fff}a.secondary{border:1px solid #2a2f3a;color:#e8ecf3}</style>
<main><h1>未检测到 CatsCompany 登录</h1>
<p>无法自动确认你的身份。可以登录后回来，或者以访客身份继续使用本应用。</p>
<a class="primary" href="${retry}">登录 CatsCompany</a>
<a class="secondary" href="${guest}">以访客身份继续</a></main></html>`;
}

// Ownership is what keeps one bot's applications out of another bot's sidebar.
// An application that does not declare an owning bot is deliberately not
// returned to a bot-scoped caller: it belongs to no bot, so it appears in no
// bot's sidebar. Only an unscoped caller (an operator or a future fleet view)
// sees it.
export function buildAppList(config, { updatedAt = null, agent = null } = {}) {
  const host = config.publicHosts[0];
  return (config.apps || [])
    .filter(app => agent === null || String(app.agent) === agent)
    .map(app => ({
      id: app.id,
      title: typeof app.title === 'string' && app.title.trim() ? app.title.trim() : app.id,
      url: `https://${host}/${app.id}/`,
      status: 'ready',
      updated_at: updatedAt,
    }));
}

function agentRef(value) {
  if (value === null) return null;
  if (!/^[0-9]{1,20}$/.test(value)) throw new Error('Invalid agent id');
  return value;
}

// Everything the routes need out of a gateway config, derived in one place so a
// reload cannot update one of `hosts`, `known` and the app list without the
// others. `stamp` is the file identity the view was read from; a view without
// one is always considered stale, which is how a freshly written config gets
// re-read instead of being trusted from memory.
function viewOf(config, { updatedAt = null, stamp = null } = {}) {
  const hosts = Array.isArray(config?.publicHosts) ? [...config.publicHosts] : [];
  // Without a host there is no public URL to hand back, and the empty string
  // would silently produce `https://undefined/...` in a launch response.
  if (hosts.length === 0) throw new Error('At least one public host is required');
  return { config, hosts, known: new Set((config.apps || []).map(app => app.id)), updatedAt, stamp };
}

// The ports the renderer already claims: the SSH transport, the WSS adapter and
// the control plane. Applications must never be handed one of them.
function reservedPorts(view) {
  return [view.config.sshPort, WSS_PORT, view.config.controlPort].filter(value => Number.isInteger(value));
}

// First free port at or above the base. Skipping every registered port makes the
// renderer's uniqueness rule hold by construction - the renderer still has the
// last word, this only avoids asking it to reject a registration the gateway
// itself could have predicted.
function allocateRemotePort(apps, { base, ceiling, reserved }) {
  const used = new Set(reserved);
  for (const app of apps) used.add(app.remotePort);
  for (let candidate = base; candidate <= ceiling; candidate++) if (!used.has(candidate)) return candidate;
  return null;
}

export function createControlPlane({
  config,
  store,
  controlToken,
  corsOrigins = [],
  cookieSecure = true,
  configUpdatedAt = null,
  configPath = null,
  transportUrl = null,
  remotePortBase = REMOTE_PORT_BASE,
  remotePortCeiling = REMOTE_PORT_CEILING,
  logger = console,
  handshakeUrl = DEFAULT_HANDSHAKE_URL,
  handshakeUrls = null,
  platformIdentityUrl = PLATFORM_IDENTITY_URL,
  platformCookieName = PLATFORM_COOKIE_NAME,
  platformIdentityTimeoutMs = PLATFORM_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!controlToken || controlToken.length < 32) throw new Error('Control token must be at least 32 characters');
  if (!store) throw new Error('Viewer store is required');
  // The tunnel endpoint a bot should connect to. Nothing in the installed
  // deployment carries it (no config field, no environment variable on the
  // gateway host), so it defaults to the first public domain - the value every
  // deployed connector actually uses. Pinned at startup on purpose: it is only
  // echoed back to callers, so a change does not need to be live.
  if (transportUrl !== null && transportUrl !== undefined && transportUrl !== '' && !TRANSPORT_URL_PATTERN.test(String(transportUrl))) throw new Error('Invalid transport URL');
  const pinnedTransportUrl = transportUrl || null;
  for (const [label, value] of [['remote port base', remotePortBase], ['remote port ceiling', remotePortCeiling]]) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${label}`);
  }
  if (remotePortBase > remotePortCeiling) throw new Error('Empty remote port range');
  let view = viewOf(config, { updatedAt: configUpdatedAt });
  // One handshake page per public domain, picked by the same suffix rule as the
  // launch URL: a visitor on `.cn` must be sent to the `.cn` login, not to the
  // other domain where they may not be signed in. Every configured entry is
  // validated here, because a typo in one of them would otherwise only surface
  // as a broken login on one of the two domains.
  if (handshakeUrls !== null && handshakeUrls !== undefined && !Array.isArray(handshakeUrls)) throw new Error('Handshake URLs must be a list');
  const handshakeList = Array.isArray(handshakeUrls) ? [...handshakeUrls] : [];
  if (handshakeList.length === 0) handshakeList.push(handshakeUrl);
  for (const candidate of handshakeList) httpsUrl(candidate, 'handshake URL');
  // An empty URL switches the platform relay off: the gateway then behaves
  // exactly as it did before the path existed.
  const platformUrl = platformIdentityUrl ? httpsUrl(platformIdentityUrl, 'platform identity URL') : null;
  const platformName = cookieName(platformCookieName);

  // --- Live configuration -----------------------------------------------------
  //
  // Registration writes the very gateway.json this process was started from,
  // and every route below is derived from it: the sidebar list, the `known` set
  // that gates /_gateway/me and /_launch/, the public hosts. Re-reading the file
  // (instead of mutating an in-memory copy after our own writes) keeps one
  // source of truth: a hand edit, scripts/register-app.mjs or a second writer is
  // picked up too, and the copy in memory cannot drift away from the file the
  // root applier renders from. The file is a few hundred bytes and the stat
  // below is the only per-request cost.
  function currentConfig() {
    if (!configPath) return view;
    let stat;
    try {
      stat = fs.statSync(configPath);
    } catch {
      // A momentarily unreadable file is not a reason to stop serving the
      // gateway: the last good view stays in use.
      return view;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (view.stamp === stamp) return view;
    try {
      view = viewOf(JSON.parse(fs.readFileSync(configPath, 'utf8')), { updatedAt: stat.mtime.toISOString(), stamp });
    } catch (error) {
      // Same for a file an operator is halfway through editing.
      logger.error(JSON.stringify({ event: 'config_reload_failed', message: error?.message }));
    }
    return view;
  }

  // Replace by rename, like scripts/register-app.mjs: nginx, sshd and the root
  // applier all render from this file, so a half-written gateway.json must never
  // be observable. Ownership survives the rename because the service user owns
  // both the old file and the temporary one; the mode is carried over so that a
  // registration is never the step that widens it.
  function writeConfig(next) {
    const mode = (() => { try { return fs.statSync(configPath).mode & 0o777; } catch { return 0o600; } })();
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, configPath);
  }

  // `updated_at` is the config file's own timestamp, read after the write so it
  // describes the file the caller's application was registered in.
  function configTimestamp() {
    if (!configPath) return new Date().toISOString();
    try {
      return fs.statSync(configPath).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  function publicUrls(hosts, id) {
    return hosts.map(host => `https://${host}/${id}/`);
  }

  function transportUrlFor(current) {
    return pinnedTransportUrl || `wss://${current.hosts[0]}/_gateway/tunnel`;
  }

  // Exactly the fields the platform hands back to the bot that published the
  // application. The public key stays on the gateway: the caller published it,
  // and the list must never read it back out.
  function registeredApp(app, current) {
    const urls = publicUrls(current.hosts, app.id);
    const local = app.localPort === undefined || app.localPort === null ? {} : { local_port: app.localPort };
    return {
      id: app.id,
      title: typeof app.title === 'string' && app.title.trim() ? app.title.trim() : app.id,
      agent: app.agent === undefined ? null : String(app.agent),
      remote_port: app.remotePort,
      url: urls[0],
      urls,
      ...local,
      updated_at: current.updatedAt,
    };
  }

  function listApplications(current) {
    return (current.config.apps || []).map(app => registeredApp(app, current));
  }

  // The same reply for POST, so a caller that just registered and a caller that
  // listed see one shape per application.
  function registrationReply(current, app, status) {
    return { status, ...registeredApp(app, current), transport_url: transportUrlFor(current) };
  }

  async function registerApplication(req, res) {
    if (!configPath) return json(res, 503, { error: 'registration_unavailable' });
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid_json' });
    // Ownership decides whose sidebar the application appears in, so an
    // application that declares no owner is refused here rather than registered
    // into no one's list.
    if (body.agent === undefined || body.agent === null || body.agent === '') return json(res, 400, { error: 'agent_required' });
    if (body.localPort !== undefined && body.localPort !== null) {
      try { port(body.localPort); } catch (error) { return json(res, 400, { error: 'invalid_local_port', message: error.message }); }
    }
    const text = value => (typeof value === 'string' ? value.trim() : value);
    const id = text(body.id);
    const current = currentConfig();
    const apps = Array.isArray(current.config.apps) ? current.config.apps : [];
    const previous = apps.find(app => app.id === id);
    // An update keeps the port the running connector was told to forward:
    // moving it would break a tunnel that is already up.
    const remotePort = previous
      ? previous.remotePort
      : allocateRemotePort(apps, { base: remotePortBase, ceiling: remotePortCeiling, reserved: reservedPorts(current) });
    if (!Number.isInteger(remotePort)) {
      return json(res, 409, { error: 'no_free_remote_port', message: `No free remote port between ${remotePortBase} and ${remotePortCeiling}` });
    }
    const entry = {
      id,
      // An update without a title keeps the one already published, so a caller
      // that only sends the key cannot silently rename somebody's sidebar entry.
      title: text(body.title) ?? previous?.title ?? id,
      agent: String(body.agent).trim(),
      remotePort,
      publicKey: text(body.publicKey),
    };
    // Same rule as the title: an update that does not send a local port keeps
    // the recorded one, so rotating a key cannot erase what the connector was
    // told to forward.
    const localPort = body.localPort === undefined || body.localPort === null ? previous?.localPort : body.localPort;
    if (localPort !== undefined && localPort !== null) entry.localPort = localPort;
    const status = previous ? 'updated' : 'registered';
    const next = { ...current.config, apps: [...apps.filter(app => app.id !== id), entry] };
    // The renderer is the only validator: it already rejects a malformed id, a
    // duplicate port, a duplicate key, a non-ed25519 key and a bot uid that is
    // not a positive integer, for sshd and nginx alike.
    try {
      renderGateway(next);
    } catch (error) {
      return json(res, 400, { error: 'invalid_registration', message: error.message });
    }
    try {
      writeConfig(next);
    } catch (error) {
      logger.error(JSON.stringify({ event: 'config_write_failed', message: error?.message }));
      return json(res, 500, { error: 'config_write_failed' });
    }
    // Publish locally before answering, with no stamp: the caller is now told
    // the application is live, so the next request on this process must already
    // see it, and reading it back from disk keeps the file authoritative.
    view = viewOf(next, { updatedAt: configTimestamp() });
    return json(res, 201, registrationReply(view, entry, status));
  }

  function removeApplication(id, res) {
    if (!configPath) return json(res, 503, { error: 'registration_unavailable' });
    const current = currentConfig();
    if (!current.known.has(id)) return json(res, 404, { error: 'unknown_app' });
    const apps = (current.config.apps || []).filter(app => app.id !== id);
    // An empty application list cannot be rendered at all - sshd needs at least
    // one PermitListen and nginx would keep no application route - so the last
    // removal is refused here instead of surfacing a renderer error for what is
    // a well formed request.
    if (!apps.length) return json(res, 409, { error: 'last_application' });
    const next = { ...current.config, apps };
    try {
      renderGateway(next);
    } catch (error) {
      return json(res, 400, { error: 'invalid_registration', message: error.message });
    }
    try {
      writeConfig(next);
    } catch (error) {
      logger.error(JSON.stringify({ event: 'config_write_failed', message: error?.message }));
      return json(res, 500, { error: 'config_write_failed' });
    }
    view = viewOf(next, { updatedAt: configTimestamp() });
    return json(res, 200, { status: 'removed', id });
  }

  // The silent path: a platform-signed visitor becomes a user record, with the
  // same pseudonym the one-shot code path mints for the same uid. There is no
  // session context behind a domain cookie, so the topic stays null.
  async function platformViewer(app, req) {
    if (!platformUrl) return null;
    const value = platformCookieValue(req, platformName);
    if (!value) return null;
    const identity = await verifyPlatformIdentity({
      url: platformUrl,
      name: platformName,
      value,
      controlToken,
      timeoutMs: platformIdentityTimeoutMs,
      fetchImpl,
      logger,
    });
    if (!identity) return null;
    let id;
    try { id = store.pseudonymFor(app, identity.uid); } catch { return null; }
    return {
      contract: VIEWER_CONTRACT,
      authenticated: true,
      viewer: viewerIdentity(id, identity.uid, identity.username),
      app_id: app,
      topic_id: null,
      expires_at: identity.expiresAt,
    };
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !corsOrigins.includes(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `https://${view.hosts[0]}`);
    } catch {
      return json(res, 400, { error: 'bad_request' });
    }
    const path = url.pathname;
    // One snapshot per request, so a reload that lands mid-request cannot make
    // the routes disagree with each other about which applications exist.
    const current = currentConfig();

    try {
      // Public read-only list for the CatsCompany sidebar.
      if (path === '/api/apps') {
        if (req.method === 'OPTIONS') return json(res, 204, {}, corsHeaders(req));
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const agent = agentRef(url.searchParams.get('agent'));
        return json(res, 200, { apps: buildAppList(current.config, { updatedAt: current.updatedAt, agent }) }, corsHeaders(req));
      }

      if (path === '/_gateway/health') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return json(res, 200, { ok: true, apps: current.known.size, ...store.stats() });
      }

      // Application inventory and registration. This is the interface that turns
      // "publish" into an API instead of an edit to the gateway host's own
      // config file, so it is deliberately absent from the rendered nginx
      // include: it is reached on the loopback control port by the platform (the
      // only caller that holds the control token), never from a public domain.
      if (path === '/_gateway/apps' || path.startsWith('/_gateway/apps/')) {
        if (!constantTimeEqual(bearerToken(req) || '', controlToken)) return json(res, 401, { error: 'unauthorized' });
        if (path !== '/_gateway/apps') {
          // The id charset is URL-safe, so the raw path segment is the id and a
          // percent-encoded one simply matches nothing.
          const id = path.slice('/_gateway/apps/'.length);
          if (req.method !== 'DELETE') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'DELETE' });
          return removeApplication(id, res);
        }
        if (req.method === 'GET') return json(res, 200, { apps: listApplications(current) });
        if (req.method === 'POST') return registerApplication(req, res);
        return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
      }

      // Internal issuance. CatsCompany calls this with the shared control
      // token; the returned code is handed to the browser exactly once.
      if (path === '/_gateway/codes') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
        if (!constantTimeEqual(bearerToken(req) || '', controlToken)) return json(res, 401, { error: 'unauthorized' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const app = appId(body.app);
        if (!current.known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const { code, expiresAt } = store.issueCode({ app, uid: body.uid, username: body.username, topic: body.topic ?? null });
        // The caller says which of our public domains its user is signed in to.
        // That is only a hint: it is matched against the configured list, so an
        // unknown value degrades to the default host instead of pointing the
        // browser at an attacker-chosen one.
        const host = matchBySuffix(current.hosts, body.host);
        return json(res, 201, {
          app_id: app,
          code,
          expires_at: expiresAt,
          launch_url: `https://${host}/_launch/${code}?next=/${app}/`,
        });
      }

      // Redeem a one-time code. Default form sets the session cookie and lands
      // on the clean application URL (top-level navigation). `format=json` is
      // the in-frame form: it returns the session ticket to the page, which
      // presents it as `Authorization: Bearer` to its own backend. Both forms
      // end in the same server-side record and the same /_gateway/me.
      if (path.startsWith('/_launch/')) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const code = path.slice('/_launch/'.length);
        const next = url.searchParams.get('next');
        const session = store.redeemCode(code);
        if (!session) return json(res, 410, { error: 'code_expired_or_used' });
        const target = next && next === `/${session.record.app}/` ? next : `/${session.record.app}/`;
        const maxAge = Math.max(1, Math.floor((session.record.exp - Date.now()) / 1000));
        if (url.searchParams.get('format') === 'json') {
          return json(res, 200, {
            app_id: session.record.app,
            token: session.token,
            expires_at: new Date(session.record.exp).toISOString(),
          });
        }
        const cookie = `${COOKIE_NAME}=${session.token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${cookieSecure ? '; Secure' : ''}`;
        res.writeHead(302, { Location: target, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
        return res.end();
      }

      // Automatic identity attempt. An application that finds itself without a
      // credential sends the browser here; this is the same code mechanism the
      // sidebar uses, so both entries end in one session record.
      if (path === '/_auth/start') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const app = appId(url.searchParams.get('app') || '');
        if (!current.known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const next = safeNext(url.searchParams.get('next'), app);
        const handshake = matchBySuffix(handshakeList, req.headers.host);
        res.writeHead(302, { Location: handshakeTarget(handshake, app, next, gatewayOrigin(req, current.hosts)), 'Cache-Control': 'no-store' });
        return res.end();
      }

      // The handshake could not prove an identity. Offer the two choices the
      // design calls for instead of silently continuing as guest.
      if (path === '/_auth/declined') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const app = appId(url.searchParams.get('app') || '');
        if (!current.known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const next = safeNext(url.searchParams.get('next'), app);
        const page = choicePage(app, next);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(page),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        });
        return res.end(page);
      }

      // Single identity output. A gateway session wins and is resolved exactly
      // as before. Without one, a platform domain cookie is the silent path; if
      // it cannot vouch for the visitor this is still a plain guest answer. Only
      // a credential the gateway did issue, but which no longer resolves, is an
      // error, so an application can re-launch instead of silently degrading a
      // signed-in user to guest.
      if (path === '/_gateway/me') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const app = appFromRequest(req, url);
        if (!app || !current.known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const token = cookieToken(req) || bearerToken(req);
        if (token) {
          const viewer = store.viewerRecord(token, app);
          if (!viewer) return json(res, 401, { contract: VIEWER_CONTRACT, error: 'invalid_or_expired', app_id: app });
          return json(res, 200, viewer);
        }
        return json(res, 200, (await platformViewer(app, req)) || store.guestRecord(app));
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error?.message === 'body_too_large') return json(res, 413, { error: 'body_too_large' });
      logger.error(JSON.stringify({ event: 'control_plane_error', path, message: error?.message }));
      return json(res, 400, { error: 'bad_request' });
    }
  });
}

export function loadControlPlaneFromEnv({ configPath, env = process.env, logger = console }) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const stateFile = env.CAG_STATE_FILE || '/var/lib/catsco-artifact-gateway/viewer-state.json';
  const controlToken = env.CAG_CONTROL_TOKEN || '';
  if (controlToken.length < 32) throw new Error('CAG_CONTROL_TOKEN must be at least 32 characters');
  const secret = env.CAG_VIEWER_SECRET ? Buffer.from(env.CAG_VIEWER_SECRET, 'base64url') : null;
  const store = new ViewerStore({
    file: stateFile,
    secret,
    codeTtlSeconds: Number(env.CAG_CODE_TTL_SECONDS || 60),
    sessionTtlSeconds: Number(env.CAG_SESSION_TTL_SECONDS || 2592000),
  });
  const configUpdatedAt = (() => {
    try { return fs.statSync(configPath).mtime.toISOString(); } catch { return null; }
  })();
  return {
    store,
    server: createControlPlane({
      config,
      store,
      controlToken,
      corsOrigins: (env.CAG_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
      cookieSecure: env.CAG_COOKIE_INSECURE !== '1',
      configUpdatedAt,
      // Registration needs the path as well as the parsed config: it writes the
      // same file back and re-reads it, so an application registered here is
      // visible to every other route without a restart.
      configPath,
      // The deployed connectors reach the tunnel on the first public domain
      // (`wss://artifact.catsco.cc/_gateway/tunnel`), which is exactly what the
      // derived default produces; an explicit value comes from the unit's
      // environment or from `transportUrl` in the config file.
      transportUrl: env.CAG_TRANSPORT_URL || config.transportUrl || null,
      handshakeUrl: env.CAG_HANDSHAKE_URL || config.handshakeUrl || undefined,
      handshakeUrls: config.handshakeUrls,
      platformIdentityUrl: env.CAG_PLATFORM_IDENTITY_URL ?? PLATFORM_IDENTITY_URL,
      platformCookieName: env.CAG_PLATFORM_COOKIE_NAME || PLATFORM_COOKIE_NAME,
      logger,
    }),
  };
}

// Standalone entry point used by deploy/control-plane.service.
if (process.argv[1] && process.argv[1].endsWith('control-plane.mjs')) {
  const configPath = process.env.CAG_CONFIG || '/etc/catsco-artifact-gateway/gateway.json';
  const port = Number(process.env.CAG_CONTROL_PORT || 22445);
  const { server } = loadControlPlaneFromEnv({ configPath });
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ event: 'control_plane_listening', port }));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
