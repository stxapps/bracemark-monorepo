#!/usr/bin/env bash
#
# End, list or forget a session in the LOCAL dev sessions database, to walk a
# signed-in client (a phone, a browser) through the three 401 verdicts by hand.
#
#   tools/scripts/dev-session.sh list [N]            the N newest sessions (default 10)
#   tools/scripts/dev-session.sh expire <id|latest>  → session_expired  (keeps the library)
#   tools/scripts/dev-session.sh revoke <id|latest>  → session_revoked  (wipes the device)
#   tools/scripts/dev-session.sh forget <id|latest>  → session_unknown  (keeps the library)
#
# `latest` is the most recently created session — the device that signed in
# last. Sign in on the device under test after any other client, or `list` and
# pass the id.
#
# The writes mirror the api's own (apps/bracemark-api/src/services/session.ts):
# `expire` moves expires_at into the past and never forward, the password-change
# expiry; `revoke` keeps an earlier revocation time, as revokeSession does;
# `forget` deletes the row, which is what a purge or restore looks like from the
# device. The client only hears the verdict on its next request — foreground the
# app, or let it sync. What each verdict must do: docs/sessions.md.
#
# The two user-level cases have real controls and need no script: Settings →
# Account → "Sign out other devices" revokes, "Change password" expires. That is
# how the e2e runner does it (e2e/runner/mobile.ts). This is for what those
# can't reach: one session revoked while the others stay signed in, idle expiry
# with the password unchanged, and an unknown token.
#
# LOCAL ONLY. `--local` is hard-coded and there is no flag to drop it: the dev
# env's SESSIONS_DB is a miniflare database (database_id "sessions-db-local"),
# and a session write against a deployed tier is a revocation of a real device.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly API_DIR="$REPO_ROOT/apps/bracemark-api"
# The repo's wrangler, by path — see deploy-worker.sh for why not a global one.
readonly WRANGLER="$REPO_ROOT/node_modules/.bin/wrangler"
readonly DB="bracemark-sessions-db-dev"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '6,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

d1() {
  (cd "$API_DIR" && "$WRANGLER" d1 execute "$DB" --env development --local --command "$1")
}

# The WHERE target for <id|latest>. Ids are UUIDs; anything else is refused
# rather than quoted into SQL.
target() {
  case "${1:-}" in
    latest) echo "id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)" ;;
    *)
      [[ "${1:-}" =~ ^[0-9a-fA-F-]{36}$ ]] || die "expected a session id or 'latest', got '${1:-}'"
      echo "id = '$1'"
      ;;
  esac
}

readonly NOW_MS="CAST(strftime('%s','now') AS INTEGER) * 1000"
readonly COLUMNS="id, user_id,
  datetime(created_at / 1000, 'unixepoch') AS created,
  datetime(expires_at / 1000, 'unixepoch') AS expires,
  datetime(revoked_at / 1000, 'unixepoch') AS revoked"

cmd="${1:-}"
[ -x "$WRANGLER" ] || die "no wrangler at $WRANGLER — run npm install"

case "$cmd" in
  list)
    n="${2:-10}"
    [[ "$n" =~ ^[0-9]+$ ]] || die "expected a count, got '$n'"
    d1 "SELECT $COLUMNS FROM sessions ORDER BY created_at DESC LIMIT $n"
    ;;
  expire)
    where="$(target "${2:-}")"
    d1 "UPDATE sessions SET expires_at = MIN(expires_at, $NOW_MS - 1)
        WHERE $where AND revoked_at IS NULL"
    d1 "SELECT $COLUMNS FROM sessions WHERE $where"
    ;;
  revoke)
    where="$(target "${2:-}")"
    d1 "UPDATE sessions SET revoked_at = COALESCE(revoked_at, $NOW_MS) WHERE $where"
    d1 "SELECT $COLUMNS FROM sessions WHERE $where"
    ;;
  forget)
    where="$(target "${2:-}")"
    # `latest` must be resolved before the row is gone, so show it first.
    d1 "SELECT $COLUMNS FROM sessions WHERE $where"
    d1 "DELETE FROM sessions WHERE $where"
    ;;
  *) usage ;;
esac
