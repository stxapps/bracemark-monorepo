#!/usr/bin/env bash
#
# `wrangler dev --env development` for bracemark-api, with the local secrets
# read from the login keychain instead of a file in this worktree.
#
#   tools/scripts/run-api-dev.sh [wrangler dev options]
#
# Normally reached through the api's `dev` target (`npx nx dev
# @stxapps/bracemark-api`, or the root `npm run dev`).
#
# WHY NOT `.dev.vars`
#
# Because some of these secrets reach production. The App Store In-App Purchase
# key is the same key in every env (one APPSTORE_KEY_ID in wrangler.jsonc) and
# works against the live Server API; the Play service account's key has no
# sandbox host at all. A plaintext copy in a gitignored file is invisible to git
# and fully visible to a backup, an editor index, a recursive grep and an AI
# agent — the CLAUDE.md tripwire, and the same reasoning that keeps the
# Cloudflare token in the keychain (tools/scripts/deploy-worker.sh). The sandbox
# Paddle secrets are harmless by comparison, but wrangler can't split the
# difference (below), so they live beside the others.
#
# HOW WRANGLER IS MADE TO READ THE SHELL
#
# Two facts about wrangler 4's local secret loading (getVarsForDev), both of
# which fail SILENTLY:
#
#   1. If `.dev.vars` or `.dev.vars.development` exists, it is the ONLY source.
#      The shell environment is not consulted at all. So this script refuses to
#      start while either file exists — see `refuse_dev_vars`.
#   2. Without a `.dev.vars`, the shell is read only if the env declares
#      `secrets.required` (wrangler.jsonc, `development` only) — and then ONLY
#      the names listed there are bound. The alternative switch,
#      CLOUDFLARE_INCLUDE_PROCESS_ENV=true, binds the ENTIRE shell environment
#      into the Worker. Never use it here.
#
# One consequence of (2): a non-secret override can no longer ride in a
# `.dev.vars*` file either. CORS_ORIGINS is the one that needs it (the LAN mode,
# docs/device-testing.md), so an exported CORS_ORIGINS is forwarded as `--var`.
#
# Requires: macOS (`security`) for the keychain, or the secrets pre-exported.
# Neither is required to start: a missing secret is reported by name and the
# routes that need it stay off, as they would with an empty `.dev.vars` line.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly API_DIR="$REPO_ROOT/apps/bracemark-api"
# The repo's wrangler, by path — see deploy-worker.sh for why not a global one.
readonly WRANGLER="$REPO_ROOT/node_modules/.bin/wrangler"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '\033[2m%s\033[0m\n' "$*" >&2; }

# NAME:keychain-service, one per entry in the `development` env's
# `secrets.required` (wrangler.jsonc). Keep the two lists identical: a name only
# here is never bound, a name only there is always "missing".
#
# The Paddle key's item is the one `npm run check:paddle` already reads for the
# `development` tier, so one item serves both.
readonly SECRETS=(
  "PADDLE_WEBHOOK_SECRET:bracemark-paddle-webhook-secret-development"
  "PADDLE_API_KEY:bracemark-paddle-key-development"
  "APPSTORE_PRIVATE_KEY:bracemark-appstore-key-development"
  "PLAY_SA_PRIVATE_KEY:bracemark-play-sa-key-development"
  "PLAY_NOTIFY_TOKEN:bracemark-play-notify-token-development"
)

refuse_dev_vars() {
  local found=()
  for f in .dev.vars .dev.vars.development; do
    [ -e "$API_DIR/$f" ] && found+=("apps/bracemark-api/$f")
  done
  [ ${#found[@]} -eq 0 ] && return 0
  die "found ${found[*]}.
       While it exists, wrangler reads secrets from it and ignores the keychain.
       Move each secret into the keychain (docs/env-files.md, _bracemark-api
       local secrets_), e.g.
         security add-generic-password -U -a bracemark -s bracemark-paddle-key-development -w
       then delete the file. A CORS_ORIGINS override goes in the shell instead:
         CORS_ORIGINS=http://<mac>.local:3000 npm run dev"
}

# Sets and exports $name from the shell or the keychain. Never prints a value.
resolve_secret() {
  local name="$1" service="$2" value
  if [ -n "${!name:-}" ]; then
    note "  $name: from the environment"
    return 0
  fi
  if ! command -v security >/dev/null 2>&1; then
    note "  $name: not set (no keychain on this platform)"
    return 0
  fi
  if ! value="$(security find-generic-password -a bracemark -s "$service" -w 2>/dev/null)" \
    || [ -z "$value" ]; then
    note "  $name: not set (no keychain item '$service')"
    return 0
  fi
  # A PEM stored WITH its newlines comes back from `security -w` hex-encoded,
  # which lib/jwt.ts pemToPkcs8 would then fail to decode on the first store
  # call — long after startup looked fine. Store PEMs flattened (tr -d '\n').
  # (A PEM stored with ESCAPED newlines — a literal backslash-n, the shape it
  # has in a service-account JSON or a dotenv line — is not that case: it comes
  # back as text, passes this check, and pemToPkcs8 drops the escapes.)
  case "$name" in
    *_PRIVATE_KEY)
      [[ "$value" == *"-----BEGIN"* ]] \
        || die "keychain item '$service' is not a PEM (stored with newlines?). Re-add it flattened:
       security add-generic-password -U -a bracemark -s $service -w \"\$(tr -d '\\n' < key.pem)\"" ;;
  esac
  printf -v "$name" '%s' "$value"
  export "${name?}"
  note "  $name: from the keychain ($service)"
}

refuse_dev_vars

note "bracemark-api local secrets:"
for entry in "${SECRETS[@]}"; do
  resolve_secret "${entry%%:*}" "${entry#*:}"
done

extra=()
if [ -n "${CORS_ORIGINS:-}" ]; then
  note "  CORS_ORIGINS: overridden from the environment ($CORS_ORIGINS)"
  extra+=(--var "CORS_ORIGINS:$CORS_ORIGINS")
fi

cd "$API_DIR"
exec "$WRANGLER" dev --env development ${extra[@]+"${extra[@]}"} "$@"
