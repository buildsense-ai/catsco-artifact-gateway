#!/bin/sh
# Apply /etc/catsco-artifact-gateway/gateway.json to the installed gateway files.
#
# Root oneshot, started by cag-apply.path when the control plane rewrites that
# file. It takes no arguments, so it can never be pointed at another path.
#
# Why a root component at all: cag_ingress owns gateway.json (0600) but has no
# sudo, and the files below are root:root in /etc. This script is the smallest
# counterpart: it re-renders with the very renderer registration validated
# against, and installs nothing that nginx or sshd would reject.
#
# Deployed paths, confirmed read-only on catsco-prod on 2026-09-20:
#   sshd            -> /etc/catsco-artifact-gateway/sshd
#                      (read by catsco-artifact-gateway-p0.service)
#   authorizedKeys  -> /etc/catsco-artifact-gateway/authorized_keys
#   locations       -> /etc/catsco-artifact-gateway/artifact-locations.conf
#                      (included by /etc/nginx/sites-enabled/catsco-artifact)
#   nginx           -> /etc/nginx/conf.d/catsco-artifact-gateway-p0.conf
#                      (http context)
set -eu

CONF=/etc/catsco-artifact-gateway
NGINX_HTTP=/etc/nginx/conf.d/catsco-artifact-gateway-p0.conf
RENDER=/opt/catsco-artifact-gateway/scripts/render.mjs
NODE=/usr/local/bin/node

[ $# -eq 0 ] || { echo "usage: $0  (takes no arguments)" >&2; exit 2; }

TMP=$(mktemp -d /run/cag-apply.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
# The control plane owns gateway.json but not this directory, so it rewrites that
# file in place rather than via a temporary file and rename. A watcher can
# therefore occasionally observe a partial document. Rendering is cheap and the
# second attempt almost always succeeds, so retry once instead of failing an
# apply that would otherwise have been fine.
"$NODE" "$RENDER" "$CONF/gateway.json" "$TMP" 2>/dev/null || {
  sleep 1
  "$NODE" "$RENDER" "$CONF/gateway.json" "$TMP"
}

# Install only what changed, keeping one .bak per file. Nothing changed means no
# reload and no restart, which is also what makes a duplicate trigger harmless.
nginx_changed=0; sshd_changed=0; failed=0
install_if_changed() { # <rendered file> <deployed file>
  cmp -s "$1" "$2" && return 0
  [ -e "$2" ] && cp -p "$2" "$2.bak"
  install -o root -g root -m 644 "$1" "$2"
  echo "applied $2"
  return 1
}
install_if_changed "$TMP/nginx" "$NGINX_HTTP" || nginx_changed=1
install_if_changed "$TMP/locations" "$CONF/artifact-locations.conf" || nginx_changed=1
install_if_changed "$TMP/authorizedKeys" "$CONF/authorized_keys" || sshd_changed=1
install_if_changed "$TMP/sshd" "$CONF/sshd" || sshd_changed=1

# Validate before touching a running service. A failed check leaves the running
# service on its old in-memory config, which is the whole rollback story here
# (the .bak above is the manual one). Restarting sshd drops live tunnels;
# connectors reconnect by themselves within a few seconds.
if [ "$nginx_changed" = 1 ]; then
  if nginx -t; then systemctl reload nginx; else echo "nginx -t failed; nginx not reloaded" >&2; failed=1; fi
fi
if [ "$sshd_changed" = 1 ]; then
  if sshd -t -f "$CONF/sshd"; then systemctl restart catsco-artifact-gateway-p0; else echo "sshd -t failed; sshd not restarted" >&2; failed=1; fi
fi
exit "$failed"
