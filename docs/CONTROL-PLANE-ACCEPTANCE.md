# Control plane acceptance · 2026-09-17

Scope: the first version of the control plane (application list + identity
exchange), its wiring into the rendered gateway configuration, and a real
deployment on the CatsCompany server with a live end-to-end run.

## Real deployment (CatsCompany server, 121.11.233.2)

Deployed on the same host as the tunnel, as a separate unprivileged service.
The tunnel (`catsco-artifact-gateway-p0`), the WSS adapter
(`catsco-artifact-gateway-wss-p0`), the old Artifact system and XiaoBa were not
restarted.

| Item | Result |
|---|---|
| `catsco-artifact-gateway-control-plane.service` | active, listening on `127.0.0.1:22445` as `cag_ingress` (UID 996) |
| `/etc/catsco-artifact-gateway/gateway.json` | created from `deploy/gateway.prod.json`, owner `cag_ingress`, mode 0600, `controlPort: 22445` |
| `/etc/catsco-artifact-gateway/control-plane.env` | created, mode 0600; generated 48-char control token, `CAG_CORS_ORIGINS=https://app.catsco.cc,https://app.catsco.cn` |
| Rendered vs previous location include | 5 control-plane locations added; `proxy_set_header Cookie ""` and `proxy_hide_header Set-Cookie` removed from both application paths; **rendered `sshd` and `authorized_keys` byte-identical** |
| `nginx -t` | syntax ok, then treated as successful |
| `/opt/catsco-artifact-gateway` permissions | tightened from 777 to 755 dirs / 644 files, `node_modules` 750 |
| Existing applications | `saturday-demo` and `standard-demo` still HTTP 200 after reload |

Backups kept in place: `/etc/catsco-artifact-gateway/backup-20260917-163611/`
(previous include, `sshd`, `authorized_keys`, vhost, http-level conf) and
`/root/catsco-artifact-gateway-opt-20260917-163611.tgz` (whole `/opt` copy
without `node_modules`).

One incident during deployment, recorded for honesty: the first start failed with
`EACCES` because `gateway.json` was created root-owned 0600 while the service runs
as `cag_ingress`; fixed by `chown cag_ingress` + 0600 and restarting.

## Real end-to-end run over the public host

All results below are from the live deployment over `https://artifact.catsco.cc`.

| Check | Result |
|---|---|
| `GET /api/apps` | 200, both applications, `updated_at` from config mtime |
| CORS with `Origin: https://app.catsco.cc` | `access-control-allow-origin` present |
| CORS with a foreign origin | no CORS header |
| `POST /_gateway/codes` with a wrong token | 401 |
| `POST /_gateway/codes` | 201 with `code` + `launch_url` |
| `GET /_launch/:code` | 302, `Location: /saturday-demo/`, `Set-Cookie: __Host-aid=…; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure` |
| `GET /_gateway/me` with that cookie | `authenticated: true`, `viewer.id: ap_BguZO5oHKb9idAI8lXNcFN`, `topic_id: topic-e2e-1` |
| same cookie against `app=standard-demo` | 401 `invalid_or_expired` |
| `GET /_gateway/me` without credential | guest, `viewer: null` |
| redeeming the same code again | 410 |
| `format=json` exchange (in-frame form) + `Authorization: Bearer` | `authenticated: true`, `topic_id: topic-e2e-2` |
| same platform uid entering twice | identical pseudonym both times |
| unknown application | 404 |
| legacy functions of the demo app (page, `/api/state`, SSE) | HTTP 200 |

## Application-side proof through the tunnel

The demo application gained a reference integration endpoint, `/api/whoami`,
which forwards the caller credential (`cookie` or `authorization`) to
`/_gateway/me` and returns the answer. It never parses a ticket itself. Deployed
to the Saturday demo (`cag-demo.service`, UID 994) and exercised publicly:

| Call | Result |
|---|---|
| `GET /saturday-demo/api/whoami` with the viewer cookie | `authenticated: true`, `topic_id: topic-e2e-3` |
| same without any credential | `authenticated: false`, `viewer: null` |
| same with `Authorization: Bearer <session ticket>` | `authenticated: true`, `topic_id: topic-e2e-4` |

This is the chain the design was about: browser credential → Nginx (no longer
stripping cookies on application paths) → tunnel → application backend → gateway
identity endpoint. The application received the credential and resolved the
viewer without holding any key.

## Local suite

`npm test` — 19 tests, 19 pass, against the real HTTP server (12 pre-existing
transport/config tests plus the new control-plane groups): one-time codes,
expiry, single-use, cross-application refusal, forged cookie 401, guest shape,
byte-identical cookie/bearer responses, pseudonym stability and non-correlation,
state surviving restart, list shape, CORS filtering, control-token check,
rendered locations, and control-port collision rejection.

## Still not verified — do not assume

1. **Browser behaviour in the real sidebar frame.** The same-site cookie is
   expected to work between `app.catsco.cc` and `artifact.catsco.cc`, but no
   browser test has been run. The `format=json` + bearer form is verified and is
   the fallback.
2. **CatsCompany patch not built.** The webapp patch applies cleanly to main
   `3fe7c518` but no `npm ci` / build / lint was run for it, and nothing was
   changed in the CatsCompany repository.
3. **Nothing in CatsCompany calls `POST /_gateway/codes` yet.** Today a code is
   issued by an operator call; the platform-side endpoint is still to be added.
4. **No load test**, no long-run soak, no rate-limit tuning beyond the P0 values.
5. **Tunnels are not restarted after a server reboot check** — the `sshd` and
   `authorized_keys` differences were verified byte-identical, so no tunnel
   change was needed, but that was not exercised by a reboot.

## Rollback

1. Stop and disable `catsco-artifact-gateway-control-plane.service`.
2. Restore `artifact-locations.conf` from
   `/etc/catsco-artifact-gateway/backup-20260917-163611/`, `nginx -t`, reload.
3. Leave `gateway.json` and the state file for inspection; delete when no longer
   needed. The tunnel, the applications and the old Artifact system were never
   part of this change.
