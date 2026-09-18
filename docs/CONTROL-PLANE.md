# Control plane

The control plane is the only part of the gateway that is not a transport. It
owns two things the tunnel cannot: the public application list and the one-shot
identity exchange. It runs as an unprivileged service on loopback and is reached
only through the Artifact virtual host.

```text
CatsCompany sidebar ──GET /api/apps──────────────────────────► list
CatsCompany backend ──POST /_gateway/codes (control token)───► one-time code
browser (new tab)   ──GET /_launch/:code─────────────────────► session cookie
browser (in frame)  ──GET /_launch/:code?format=json─────────► session ticket
browser (no ticket) ──GET /_auth/start───────────────────────► platform handshake
browser (no identity) ──GET /_auth/declined──────────────────► login or guest choice
application backend ──GET /_gateway/me───────────────────────► viewer or guest
```

## Identity contract

One concept, two lifetimes: a **code** is a one-time ticket that lives seconds
and is redeemed into a **session** that lives days. Both are opaque random
strings. The server keeps four fields per record and nothing else:

| Field | Meaning |
|---|---|
| `app` | application the ticket is valid for |
| `sub` | application-scoped pseudonym (`ap_…`, HMAC of secret + app + uid) |
| `topic` | CatsCompany topic the entry came from, or null |
| `exp` | expiry; one-time records additionally carry `used` |

There is no signature, no version field, no issuer metadata and no key
distribution. Verification is a table lookup, revocation is deleting a row, and
a ticket minted for one application is refused for another even though both
share the origin.

`GET /_gateway/me` returns the same shape for every entry path:

```json
{
  "contract": "catsco.artifact-viewer.v1",
  "authenticated": true,
  "viewer": { "id": "ap_9f3c…", "kind": "user" },
  "app_id": "saturday-demo",
  "topic_id": "t_…",
  "expires_at": "2026-10-17T04:00:00.000Z"
}
```

Guest access returns `authenticated: false` with `viewer: null`. A credential
that is present but invalid returns `401`, so an application can re-launch
instead of silently downgrading a signed-in user.

## How an application connects

An application needs no SDK, no key and no registration of permissions.

1. Every request arrives with the viewer cookie `__Host-aid` (HttpOnly, Secure,
   SameSite=Lax). In an iframe the page may instead receive a one-time code in
   the URL fragment.
2. Forward the credential to the identity endpoint and read the result:

```js
async function whoami(req) {
  const res = await fetch('https://artifact.catsco.cc/_gateway/me?app=my-app', {
    headers: {
      cookie: req.headers.cookie || '',
      authorization: req.headers.authorization || '',
    },
  });
  return res.json();
}
```

3. Decide locally. `viewer.id` is stable inside one application and not
   correlatable across applications, so it is a valid primary key for a local
   ACL (`acl.json`, or a SQLite table keyed by viewer + topic). Guests are the
   application's own policy decision.

The application never parses or validates the credential itself; it only
forwards it. `__Host-aid` is HttpOnly, so page script can neither read nor
replace it, and the gateway checks the record's `app` against the requested
application, so a cookie taken from one application cannot be replayed against
another.

## Identity on first load

Opening an application URL directly is not a guest-only path. Every entry, from
the sidebar or from a pasted link, follows the same three steps:

```text
1. credential present        -> enter with that identity
2. no credential             -> GET /_auth/start, i.e. one automatic attempt
                                to obtain an identity from CatsCompany
3. attempt did not succeed   -> /_auth/declined offers
                                [log in to CatsCompany] [continue as guest]
```

Step 2 is a plain top-level redirect to the platform handshake page, which lives
on the platform origin where the user's existing login session is available; it
returns a one-time code, and the existing `/_launch/:code` turns that code into a
session. It is the same code mechanism the sidebar uses, not a second path, and
it needs no third-party cookie access, no iframe and no browser fingerprinting.

An application triggers it with two lines and marks the guest choice so the
attempt is not repeated in a loop:

```js
const params = new URLSearchParams(location.search);
if (params.get('identity') === 'guest') return;          // user chose guest
const me = await fetch('/_gateway/me?app=my-app').then(r => r.json());
if (!me.authenticated) location.replace('/_auth/start?app=my-app&next=' + encodeURIComponent(location.pathname));
```

`next` is restricted to paths inside the requesting application, so the endpoint
cannot be used as an open redirect.

## In-frame entry

Browsers block third-party cookies inside frames, so the sidebar path uses the
same code with `format=json`: the page exchanges the fragment code and presents
the returned session ticket as `Authorization: Bearer` to its own backend. Both
forms land in the same server-side record and the same `/_gateway/me`, so the
application keeps a single code path.

Whether the same-site cookie is accepted inside the CatsCompany sidebar frame
must be confirmed in a real browser (see `docs/CONTROL-PLANE-ACCEPTANCE.md`);
the bearer form is the tested fallback and needs no application change.

## Configuration

`gateway.json` gains one optional field:

```json
{ "controlPort": 22445 }
```

When present, the rendered location include adds `/api/apps`, `/_gateway/me`,
`/_gateway/codes`, `/_gateway/health` and `/_launch/` to the control plane and
stops stripping cookies on application paths. The tunnel location is unchanged
and still strips cookies.

Environment for `deploy/control-plane.service` (`/etc/catsco-artifact-gateway/control-plane.env`):

| Variable | Purpose |
|---|---|
| `CAG_CONTROL_TOKEN` | shared secret for `POST /_gateway/codes`; at least 32 chars |
| `CAG_STATE_FILE` | viewer state, defaults to `/var/lib/catsco-artifact-gateway/viewer-state.json` |
| `CAG_CORS_ORIGINS` | comma-separated origins allowed to read `/api/apps` |
| `CAG_HANDSHAKE_URL` | platform handshake page for `/_auth/start`; defaults to `https://app.catsco.cc/artifact-auth`, can also come from `handshakeUrl` in `gateway.json` |
| `CAG_CODE_TTL_SECONDS` / `CAG_SESSION_TTL_SECONDS` | 60 / 2592000 by default |
| `CAG_COOKIE_INSECURE` | test only: drop `Secure` for plain-HTTP local runs |

The pseudonym secret is generated on first start and stored in the state file
with mode 0600; it is never distributed to applications.
