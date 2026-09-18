// Control plane for the light Artifact gateway.
//
// It owns exactly two things the tunnel cannot: the public application list and
// the one-shot identity exchange. Applications never see a key and never parse
// a ticket; they forward the credential to `/_gateway/me` and read the result.
import http from 'node:http';
import fs from 'node:fs';
import { appId, COOKIE_NAME, isToken, ViewerStore, VIEWER_CONTRACT } from './viewer-store.mjs';

const MAX_BODY = 8 * 1024;

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

// The host the browser actually used, so the handshake returns the visitor to
// the same domain instead of always the first configured one.
function gatewayOrigin(req, hosts) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  return `https://${hosts.includes(host) ? host : hosts[0]}`;
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

export function createControlPlane({ config, store, controlToken, corsOrigins = [], cookieSecure = true, configUpdatedAt = null, logger = console, handshakeUrl = 'https://app.catsco.cc/artifact-auth' }) {
  if (!controlToken || controlToken.length < 32) throw new Error('Control token must be at least 32 characters');
  if (!store) throw new Error('Viewer store is required');
  if (!/^https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9/_-]+$/.test(handshakeUrl)) throw new Error('Invalid handshake URL');
  const hosts = [...config.publicHosts];
  const known = new Set((config.apps || []).map(app => app.id));

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
      url = new URL(req.url, `https://${hosts[0]}`);
    } catch {
      return json(res, 400, { error: 'bad_request' });
    }
    const path = url.pathname;

    try {
      // Public read-only list for the CatsCompany sidebar.
      if (path === '/api/apps') {
        if (req.method === 'OPTIONS') return json(res, 204, {}, corsHeaders(req));
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const agent = agentRef(url.searchParams.get('agent'));
        return json(res, 200, { apps: buildAppList(config, { updatedAt: configUpdatedAt, agent }) }, corsHeaders(req));
      }

      if (path === '/_gateway/health') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return json(res, 200, { ok: true, apps: known.size, ...store.stats() });
      }

      // Internal issuance. CatsCompany calls this with the shared control
      // token; the returned code is handed to the browser exactly once.
      if (path === '/_gateway/codes') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
        if (!constantTimeEqual(bearerToken(req) || '', controlToken)) return json(res, 401, { error: 'unauthorized' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const app = appId(body.app);
        if (!known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const { code, expiresAt } = store.issueCode({ app, uid: body.uid, topic: body.topic ?? null });
        return json(res, 201, {
          app_id: app,
          code,
          expires_at: expiresAt,
          launch_url: `https://${hosts[0]}/_launch/${code}?next=/${app}/`,
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
        if (!known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const next = safeNext(url.searchParams.get('next'), app);
        res.writeHead(302, { Location: handshakeTarget(handshakeUrl, app, next, gatewayOrigin(req, hosts)), 'Cache-Control': 'no-store' });
        return res.end();
      }

      // The handshake could not prove an identity. Offer the two choices the
      // design calls for instead of silently continuing as guest.
      if (path === '/_auth/declined') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const app = appId(url.searchParams.get('app') || '');
        if (!known.has(app)) return json(res, 404, { error: 'unknown_app' });
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

      // Single identity output. A missing credential means guest; a present but
      // invalid credential is an error, so an application can re-launch instead
      // of silently degrading a signed-in user to guest.
      if (path === '/_gateway/me') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        const app = appFromRequest(req, url);
        if (!app || !known.has(app)) return json(res, 404, { error: 'unknown_app' });
        const token = cookieToken(req) || bearerToken(req);
        if (!token) return json(res, 200, store.guestRecord(app));
        const viewer = store.viewerRecord(token, app);
        if (!viewer) return json(res, 401, { contract: VIEWER_CONTRACT, error: 'invalid_or_expired', app_id: app });
        return json(res, 200, viewer);
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
      handshakeUrl: env.CAG_HANDSHAKE_URL || config.handshakeUrl || undefined,
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
