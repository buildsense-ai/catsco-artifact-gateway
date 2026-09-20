// Viewer token store for the light Artifact gateway.
//
// One concept, two lifetimes: a code is a one-time ticket (seconds) that is
// redeemed into a session ticket (days). Both are opaque random strings; the
// server keeps only app / sub / topic / exp / used. No signature, no parsed
// fields, no key distribution to applications.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VIEWER_CONTRACT = 'catsco.artifact-viewer.v1';
export const COOKIE_NAME = '__Host-aid';

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MIN_TTL_SECONDS = 1;

export function appId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) throw new Error('Invalid application id');
  return value;
}

export function isToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

// Topic ids come from CatsCompany; keep the accepted shape narrow but not
// opinionated about their internal format.
export function topicRef(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error('Invalid topic id');
  return value;
}

function subjectRef(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error('Invalid subject');
  return value;
}

function seconds(value, field) {
  if (!Number.isInteger(value) || value < MIN_TTL_SECONDS || value > 60 * 60 * 24 * 400) throw new Error(`Invalid ${field}`);
  return value;
}

// App-scoped pseudonym: stable ACL key for one user inside one application,
// not correlatable across applications, and never the raw platform uid.
export function pseudonym(secret, app, uid) {
  appId(app);
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('Viewer secret must be at least 32 bytes');
  const value = String(uid ?? '');
  if (value === '' || /[\r\n\0]/.test(value)) throw new Error('Invalid uid');
  return 'ap_' + crypto.createHmac('sha256', secret).update(`${app}\u0000${value}`).digest('base64url').slice(0, 22);
}

// The platform uid as it travels into the gateway. It is an identifier, never a
// credential. This layer keeps it an opaque bounded string on purpose: what the
// store mints from a subject is what the contract pins, not its spelling, and
// the one place that must insist on digits is the platform response itself.
export function uidRef(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || text === '' || text.length > 128 || /[\r\n\0]/.test(text)) throw new Error('Invalid uid');
  return text;
}

// The same value as the number the contract publishes. Only a plain digit run
// becomes a number; anything else publishes null rather than a rounded or
// invented value. A uid beyond the safe integer range reports null too, because
// it would already have lost precision in the platform's own JSON.
export function uidNumber(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]{1,19}$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// The readable account name, so an application can anchor its own rows to a
// platform account. Optional on purpose: it is additive to the contract, so a
// platform release that does not send it yet keeps working and reports null.
// Never trimmed or case-folded — this is an anchor, not a label.
export function usernameRef(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || /[\r\n\0]/.test(value)) throw new Error('Invalid username');
  return value;
}

// The single application-facing identity shape, shared by both entry paths so
// the one-shot code and the silent platform cookie cannot disagree about a
// user. `id` stays the pseudonym: applications already store it as their local
// key, so removing it would orphan what they already wrote down.
export function viewerIdentity(sub, uid, username) {
  return { id: sub, uid: uidNumber(uid), username: usernameRef(username), kind: 'user' };
}

export class ViewerStore {
  constructor({ file, secret, codeTtlSeconds = 60, sessionTtlSeconds = 2592000, now = () => Date.now() }) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Viewer state file must be an absolute path');
    this.file = file;
    this.codeTtlSeconds = seconds(codeTtlSeconds, 'codeTtlSeconds');
    this.sessionTtlSeconds = seconds(sessionTtlSeconds, 'sessionTtlSeconds');
    this.now = now;
    this.state = this.#load();
    if (secret) {
      if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('Viewer secret must be at least 32 bytes');
      this.secret = secret;
    } else if (typeof this.state.secret === 'string' && this.state.secret) {
      this.secret = Buffer.from(this.state.secret, 'base64url');
    } else {
      this.secret = crypto.randomBytes(32);
      this.state.secret = this.secret.toString('base64url');
      this.#save();
    }
  }

  pseudonymFor(app, uid) {
    return pseudonym(this.secret, app, uid);
  }

  // Issue a one-time code bound to (app, subject, topic). The platform uid and
  // account name ride along so the redeemed session can answer with the same
  // identity the silent path produces.
  issueCode({ app, uid, username = null, topic = null }) {
    appId(app);
    const record = {
      kind: 'code',
      app,
      sub: this.pseudonymFor(app, uid),
      uid: uidRef(uid),
      username: usernameRef(username),
      topic: topicRef(topic),
      exp: this.now() + this.codeTtlSeconds * 1000,
      used: false,
    };
    const code = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    this.#purge();
    this.state.codes[code] = record;
    this.#save();
    return { code, expiresAt: new Date(record.exp).toISOString() };
  }

  // Redeem a code once; returns the issued session token and its record.
  redeemCode(code, { app = null } = {}) {
    if (!isToken(code)) return null;
    this.#purge();
    const record = this.state.codes[code];
    if (!record || record.used || record.exp <= this.now()) return null;
    if (app !== null && record.app !== app) return null;
    record.used = true;
    delete this.state.codes[code];
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const session = {
      kind: 'session',
      app: record.app,
      sub: record.sub,
      uid: record.uid ?? null,
      username: record.username ?? null,
      topic: record.topic,
      exp: this.now() + this.sessionTtlSeconds * 1000,
      used: false,
    };
    this.state.sessions[token] = session;
    this.#save();
    return { token, record: session };
  }

  // Resolve a session ticket. `app` scopes the lookup so a cookie or bearer
  // token minted for one application cannot be replayed against another.
  resolve(token, { app }) {
    if (!isToken(token)) return null;
    appId(app);
    this.#purge();
    const record = this.state.sessions[token];
    if (!record || record.exp <= this.now() || record.app !== app) return null;
    return record;
  }

  revoke(token) {
    if (!isToken(token)) return false;
    const existed = Boolean(this.state.sessions[token]);
    if (existed) {
      delete this.state.sessions[token];
      this.#save();
    }
    return existed;
  }

  stats() {
    this.#purge();
    return { sessions: Object.keys(this.state.sessions).length, codes: Object.keys(this.state.codes).length };
  }

  viewerRecord(token, app) {
    const record = this.resolve(token, { app });
    if (!record) return null;
    return {
      contract: VIEWER_CONTRACT,
      authenticated: true,
      viewer: viewerIdentity(record.sub, record.uid, record.username),
      app_id: record.app,
      topic_id: record.topic,
      expires_at: new Date(record.exp).toISOString(),
    };
  }

  guestRecord(app) {
    return {
      contract: VIEWER_CONTRACT,
      authenticated: false,
      viewer: null,
      app_id: app ?? null,
      topic_id: null,
      expires_at: null,
    };
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        secret: typeof raw.secret === 'string' ? raw.secret : '',
        codes: raw.codes && typeof raw.codes === 'object' ? raw.codes : {},
        sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      };
    } catch {
      return { secret: '', codes: {}, sessions: {} };
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  #purge() {
    const now = this.now();
    let changed = false;
    for (const [key, record] of Object.entries(this.state.codes)) {
      if (!record || record.used || record.exp <= now) { delete this.state.codes[key]; changed = true; }
    }
    for (const [key, record] of Object.entries(this.state.sessions)) {
      if (!record || record.exp <= now) { delete this.state.sessions[key]; changed = true; }
    }
    if (changed) this.#save();
  }
}

export function subjectOf(app, uid) {
  return subjectRef(String(uid));
}
