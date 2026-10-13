#!/usr/bin/env bash
#
# Deploy one of the two Cloudflare Workers — bracemark-api or bracemark-extractor
# — to its tier's Cloudflare account, applying that tier's D1 migrations first.
#
#   tools/scripts/deploy-worker.sh <api|extractor> <staging|production> [options]
#
# Normally reached through the root package.json aliases:
#
#   npm run deploy:api:staging        npm run deploy:api:production
#   npm run deploy:extractor:staging  npm run deploy:extractor:production
#
# The sibling of tools/scripts/deploy-static.sh, and deliberately shaped like it
# — same flags, same production prompt, same "resolve the credential and prove
# it points at the right tier BEFORE anything is written" preflight. Read that
# script's header for the half of the deploy story that lives on AWS.
#
# WHY THIS SCRIPT EXISTS RATHER THAN `nx deploy`
#
# `wrangler deploy --env <tier>` is one command and the Nx targets already wrap
# it. What it does not do is any of the five things that make a deploy safe here:
#
#   1. Resolve THIS TIER'S API token, and only this tier's. Each tier is its own
#      Cloudflare account (docs/hosting.md, _why staging is a separate
#      registrable domain_), and `account_id` is deliberately absent from both
#      wrangler.jsonc files, so the token's scope is the only thing standing
#      between a mistyped command and a deploy into the wrong tier. The token
#      comes from the login keychain, per tier, and is never read from a file in
#      this worktree — see `resolve_token`.
#   2. Fail when no token is found. Bare `wrangler` would silently fall back to
#      an OAuth session from `wrangler login`, which authenticates the USER —
#      and one user owns both accounts, so that session reaches production.
#      There is no fallback here on purpose.
#   3. Apply the D1 migrations REMOTELY. `wrangler d1 migrations apply` targets
#      the LOCAL miniflare database when neither --local nor --remote is passed,
#      and reports success — see `apply_migrations`.
#   4. Prove the Worker came up. A Worker deploy is instant and returns success
#      the moment the upload lands; the health check is the only thing that says
#      the thing now answering that hostname is the thing you just built.
#   5. Record WHICH COMMIT shipped — a local git tag, and the same commit on the
#      Worker version itself — and refuse to ship uncommitted work to production
#      (tools/scripts/deploy-commit.sh; docs/hosting.md, _which commit is live_).
#
# Requires: macOS (`security`, for the keychain) or a pre-exported
# CLOUDFLARE_API_TOKEN, git, and this repo's own wrangler — never a global one.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The repo's wrangler, by path. `npx wrangler` would find it too, but a globally
# installed wrangler shadows it in some shells — and a global copy keeps its OWN
# auth store, so `whoami` in two terminals can disagree about which account is
# about to be deployed to. Resolve it once, explicitly.
readonly WRANGLER="$REPO_ROOT/node_modules/.bin/wrangler"

usage() {
  cat >&2 <<'USAGE'
Usage: deploy-worker.sh <api|extractor> <staging|production> [options]

Options:
  --dry-run             Compile and list pending migrations; apply nothing,
                        deploy nothing.
  --skip-migrate        Don't apply D1 migrations (bracemark-api only).
  --no-deploy           Apply migrations but don't deploy the Worker.
  --no-smoke            Skip the post-deploy /health check.
  --allow-todo          Deploy even though the config still holds TODO values.
                        A warning on staging; required on production.
  --allow-dirty         Deploy with uncommitted changes, untagged.
                        A warning on staging; required on production.
  --yes, -y             Don't prompt before a production deploy.
  -h, --help            Show this message.

Credentials:
  CLOUDFLARE_API_TOKEN            Read from the shell first; otherwise from the
                                  login keychain, item `bracemark-cf-token-<tier>`.
                                  There is no third fallback — see the header.

Environment (read from the app's gitignored .env.<tier>.local):
  CLOUDFLARE_ACCOUNT_ID           Used to CHECK the token's account, not to select
                                  it. Wrangler reads the same file for itself.
USAGE
}

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# --- arguments -------------------------------------------------------------

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
[ "$#" -ge 2 ] || { usage; exit 1; }

readonly APP="$1"
readonly TIER="$2"
shift 2

case "$APP" in
  api|extractor) ;;
  *) die "unknown app '$APP' (expected 'api' or 'extractor')" ;;
esac
case "$TIER" in
  staging|production) ;;
  *) die "unknown tier '$TIER' (expected 'staging' or 'production')" ;;
esac

DRY_RUN=false
SKIP_MIGRATE=false
DEPLOY=true
SMOKE=true
ALLOW_TODO=false
ALLOW_DIRTY=false
ASSUME_YES=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --skip-migrate) SKIP_MIGRATE=true ;;
    --no-deploy) DEPLOY=false ;;
    --no-smoke) SMOKE=false ;;
    --allow-todo) ALLOW_TODO=true ;;
    --allow-dirty) ALLOW_DIRTY=true ;;
    --yes|-y) ASSUME_YES=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$1'" ;;
  esac
  shift
done

readonly PROJECT="@stxapps/bracemark-$APP"
readonly APP_DIR="$REPO_ROOT/apps/bracemark-$APP"

# The Worker's `name` in wrangler.jsonc auto-suffixes with the environment name,
# so the deployed name IS the tier (docs/hosting.md, _naming conventions_).
readonly WORKER="bracemark-$APP-$TIER"

# The two tiers sit on two different registrable domains, and within a domain the
# pattern is `<role>.<domain>` — where the role label is exactly this script's
# first argument. docs/hosting.md, _the hosts_.
if [ "$TIER" = "staging" ]; then
  readonly DOMAIN="dryrunbase.com"
  readonly OTHER_TIER="production"
else
  readonly DOMAIN="bracemark.com"
  readonly OTHER_TIER="staging"
fi
readonly HOST="$APP.$DOMAIN"

# One D1 binding per role, each with its own migration history. Named here rather
# than parsed out of wrangler.jsonc because a missed binding is a database that
# silently never migrates — apps/bracemark-api/src/db/migrations/README.md.
# bracemark-extractor is a pure function and has no storage bindings at all.
if [ "$APP" = "api" ]; then
  readonly D1_BINDINGS=(DIRECTORY_DB ACCOUNTS_DB_1 SESSIONS_DB)
else
  readonly D1_BINDINGS=()
fi

[ -x "$WRANGLER" ] || die "$WRANGLER not found — run 'npm install' (wrangler is a repo devDependency, never install it globally)"
[ -f "$APP_DIR/wrangler.jsonc" ] || die "missing $APP_DIR/wrangler.jsonc"

step "Deploying $PROJECT → $WORKER ($HOST)"

# Before the credential is asked for: nothing below can make a dirty production
# deploy acceptable, and the keychain prompt should not be spent finding that out.
. "$REPO_ROOT/tools/scripts/deploy-commit.sh"
resolve_deploy_commit

# --- the credential --------------------------------------------------------
#
# Never from a file in this worktree. The account id lives in a gitignored
# `.env.<tier>.local` beside wrangler.jsonc and that is fine — it is an
# identifier, and leaking it grants nothing. A token is a credential: it is the
# ONLY thing scoping a deploy to one tier (see the header), so a plaintext copy
# of it in the tree is one backup, one `cp -r`, one over-broad file read away
# from being a production write. It lives in the login keychain instead, which is
# where the AWS half of this deploy keeps its credential too (~/.aws), and it is
# put into the environment for the length of this script and no longer.
#
#   security add-generic-password -a bracemark -s bracemark-cf-token-staging -w
#   security add-generic-password -a bracemark -s bracemark-cf-token-production -w
#
# Mint each one as an ACCOUNT-owned token (`cfat_…`) against that tier's account,
# never a user token: a user token offers "All accounts" as a resource scope, and
# one user owns both of these accounts.
readonly KEYCHAIN_SERVICE="bracemark-cf-token-$TIER"

resolve_token() {
  # An exported value wins, so CI passes a real env var and a one-off
  # `CLOUDFLARE_API_TOKEN=… npm run deploy:…` still works.
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    note "token: from the environment"
    return 0
  fi
  command -v security >/dev/null 2>&1 \
    || die "no CLOUDFLARE_API_TOKEN, and no keychain on this platform.
       Export the token for this tier, or add one to a secret store and read it here."
  # First use in a session prompts for keychain access. That prompt is a feature:
  # it is the one moment a production deploy asks you to confirm you meant it
  # before any preflight has run.
  CLOUDFLARE_API_TOKEN="$(security find-generic-password -a bracemark -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" \
    || die "no keychain item '$KEYCHAIN_SERVICE'. Add this tier's Cloudflare API token with:
       security add-generic-password -a bracemark -s $KEYCHAIN_SERVICE -w
       (an ACCOUNT-owned token minted against the $TIER account, not a user token)"
  [ -n "$CLOUDFLARE_API_TOKEN" ] || die "keychain item '$KEYCHAIN_SERVICE' is empty"
  note "token: from the keychain ($KEYCHAIN_SERVICE)"
}

resolve_token
export CLOUDFLARE_API_TOKEN

# --- does the token point at this tier? ------------------------------------
#
# The same shape as deploy-static.sh's `verify_tier`: compute what this tier's
# id is and what the OTHER tier's is, then insist on the first and refuse the
# second. Both come from the gitignored per-tier files, so no account id is
# written down here.
#
# This is a SECOND opinion, not the guard. An account-owned token can only reach
# its own account, which is what actually makes a wrong-tier deploy impossible;
# what this catches is the case where someone has fallen back to a user token
# that spans both. It needs Account Settings:Read to say anything at all, so a
# token minted without it gets a warning rather than a failure — the token scope
# is still holding underneath.

# Read one KEY=value out of a dotenv file WITHOUT sourcing it (a dotenv line is
# not shell) and WITHOUT exporting it — wrangler reads these files itself, and
# this script only wants to compare.
env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    case "$line" in "$key="*) ;; *) continue ;; esac
    value="${line#*=}"
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s' "$value"
    return 0
  done < "$file"
}

verify_account() {
  local want forbid whoami_out
  want="$(env_value "$APP_DIR/.env.$TIER.local" CLOUDFLARE_ACCOUNT_ID)"
  forbid="$(env_value "$APP_DIR/.env.$OTHER_TIER.local" CLOUDFLARE_ACCOUNT_ID)"

  if [ -z "$want" ]; then
    warn "no CLOUDFLARE_ACCOUNT_ID in $APP_DIR/.env.$TIER.local — skipping the account check.
       The token's own scope is the only guard left; be sure it is account-owned."
    return 0
  fi

  whoami_out="$("$WRANGLER" whoami 2>&1 || true)"

  if [ -n "$forbid" ] && printf '%s' "$whoami_out" | grep -qF -- "$forbid"; then
    die "this token can reach the $OTHER_TIER account. Refusing to deploy $WORKER with it.
       Mint an ACCOUNT-owned token against the $TIER account only — a user token
       scoped to 'All accounts' reaches both, and nothing downstream would object."
  fi
  if printf '%s' "$whoami_out" | grep -qF -- "$want"; then
    note "cloudflare account: $TIER (confirmed)"
    return 0
  fi
  warn "could not confirm the token's account (needs Account Settings:Read).
       Proceeding on the token's scope alone."
}

step "Checking the credential points at $TIER"
verify_account

# --- compile ---------------------------------------------------------------
#
# No --outdir: the `build` target owns apps/bracemark-<app>/dist and its Nx
# cache entry, and this is a gate rather than an artifact. Unlike the two static
# apps there IS no per-tier artifact to protect — a Worker bundle bakes nothing,
# because config is read at runtime from `c.env` (docs/env-files.md) — so this
# compiles the tier it is about to deploy purely to fail before any migration
# runs, not because the bytes differ.

step "Compiling $PROJECT for $TIER"
DRYRUN_OUT="$(cd "$APP_DIR" && "$WRANGLER" deploy --env "$TIER" --dry-run 2>&1)" || {
  printf '%s\n' "$DRYRUN_OUT" >&2
  die "the Worker does not build for $TIER"
}
printf '%s\n' "$DRYRUN_OUT"

# --- unfilled config -------------------------------------------------------
#
# wrangler prints every `vars` value in the dry-run summary above, so a
# placeholder that was never filled in is visible here — and only here. Nothing
# else catches it: a TODO string is a perfectly valid string, so it deploys, and
# the symptom is a runtime one (checkout selling a price id that does not exist,
# a store receipt that never verifies).
#
# Fatal on production, a warning on staging. Staging is where these get filled in
# one at a time as the sandbox accounts behind them come into existence, so a
# hard stop there would block the very deploys you need to make progress; on
# production every one of them is a live billing path.
check_todo() {
  local todos
  todos="$(printf '%s' "$DRYRUN_OUT" | grep -F 'TODO' || true)"
  [ -n "$todos" ] || return 0

  printf '\n'
  warn "$WORKER still carries unfilled config:"
  printf '%s\n' "$todos" | sed 's/^/       /' >&2

  if [ "$ALLOW_TODO" = true ]; then
    warn "continuing anyway (--allow-todo)"
    return 0
  fi
  # A --dry-run is a diagnostic — let it finish and show the rest of the picture
  # rather than stopping on the very thing it was run to surface.
  [ "$DRY_RUN" = false ] || return 0
  [ "$TIER" = "production" ] || return 0
  die "refusing to deploy these to production. Fill them in, or pass --allow-todo."
}
check_todo

# --- confirm ---------------------------------------------------------------

if [ "$TIER" = "production" ] && [ "$DRY_RUN" = false ]; then
  if [ "$ASSUME_YES" = false ]; then
    if [ ! -t 0 ]; then
      die "production deploy in a non-interactive shell — pass --yes if you mean it"
    fi
    printf '\n    This is \033[1mPRODUCTION\033[0m (%s). Type the Worker name to continue: ' "$WORKER"
    read -r CONFIRM
    [ "$CONFIRM" = "$WORKER" ] || die "aborted"
  fi
fi

# --- migrations ------------------------------------------------------------
#
# BEFORE the deploy, always. Every migration is additive by rule
# (apps/bracemark-api/src/db/migrations/README.md), so the old code runs fine
# against the new schema but the new code may not run against the old one — which
# makes migrate-then-deploy the only ordering that is safe in both directions.
#
# --remote IS THE POINT. `wrangler d1 migrations apply` defaults to the LOCAL
# miniflare database when neither --local nor --remote is given, prints
# "Resource location: local", and exits 0. Drop the flag and a production
# migration writes to a SQLite file under .wrangler/ and reports success, leaving
# the real database untouched and the Worker serving against tables that do not
# exist yet.
#
# `migrations list` first: it resolves the binding to its database_id and hits
# the remote API, so it is also the check that the id in wrangler.jsonc is real,
# is reachable by THIS token, and lives in THIS account. A TODO placeholder or an
# id belonging to the other tier fails here, before anything is written.

apply_migrations() {
  local binding
  for binding in "${D1_BINDINGS[@]}"; do
    step "D1 $binding — pending migrations"
    (cd "$APP_DIR" && "$WRANGLER" d1 migrations list "$binding" --env "$TIER" --remote) \
      || die "cannot reach $binding in the $TIER account.
       Either its database_id in wrangler.jsonc is still a placeholder (create it with
       'wrangler d1 create bracemark-<role>-db-$TIER' and paste the id), or it belongs
       to a different account than this token."
  done

  if [ "$DRY_RUN" = true ]; then
    step "Dry run — no migrations applied"
    return 0
  fi

  for binding in "${D1_BINDINGS[@]}"; do
    step "Applying D1 migrations to $binding ($TIER)"
    # Non-interactive shells skip wrangler's own confirmation prompt, which is
    # why this script has its own production gate above rather than relying on it.
    (cd "$APP_DIR" && "$WRANGLER" d1 migrations apply "$binding" --env "$TIER" --remote)
  done
}

if [ "${#D1_BINDINGS[@]}" -eq 0 ]; then
  step "No D1 migrations — bracemark-extractor has no storage bindings"
elif [ "$SKIP_MIGRATE" = true ]; then
  step "Skipping D1 migrations (--skip-migrate)"
  note "the deploy below will serve against whatever schema is already there"
else
  apply_migrations
fi

# --- deploy ----------------------------------------------------------------

if [ "$DRY_RUN" = true ]; then
  step "Dry run — nothing was applied and nothing was deployed"
  exit 0
fi

if [ "$DEPLOY" = false ]; then
  step "Skipping the deploy (--no-deploy)"
  exit 0
fi

step "Deploying $WORKER"
# Secrets are NOT touched: `wrangler deploy` never deletes them, and they are set
# out of band with `wrangler secret bulk --env <tier>`. `vars` ARE replaced from
# wrangler.jsonc, which is what we want — that file is their source of truth, so
# --keep-vars is deliberately absent.
#
# The first deploy of an environment whose `routes` entry is uncommented also
# provisions the custom domain: the DNS record and its certificate, in that
# tier's zone. That is the one part of this script that touches DNS, and it needs
# the zone to be in the same account as the Worker.
#
# --tag / --message put the commit on the Worker version itself, which is the
# half of the record that does not depend on this clone: `wrangler versions list
# --env <tier>` shows them beside every version id, and `wrangler rollback
# <version-id>` is how a bad deploy is undone — in seconds, without a rebuild.
# What a rollback does NOT undo is a D1 migration; those are additive by rule,
# which is exactly what makes the older code safe against the newer schema.
name_deploy
if [ "$DEPLOY_DIRTY" = true ]; then
  DEPLOY_MESSAGE="$DEPLOY_TAG (untagged: dirty tree)"
else
  DEPLOY_MESSAGE="$DEPLOY_TAG"
fi
(cd "$APP_DIR" && "$WRANGLER" deploy --env "$TIER" --tag "$DEPLOY_STAMP" --message "$DEPLOY_MESSAGE")
tag_deploy

# --- smoke -----------------------------------------------------------------
#
# The static deploy's equivalent of this is waiting for the CloudFront
# invalidation. A Worker deploy has nothing to wait for — it returns the moment
# the upload lands — so the health check is the only thing that says the code now
# answering that hostname is the code you just built. It is also the first thing
# that exercises the custom domain, which on a first deploy may still be
# provisioning its certificate.

if [ "$SMOKE" = false ]; then
  step "Skipping the health check (--no-smoke)"
  step "Deployed $WORKER"
  exit 0
fi

step "Checking https://$HOST/health"
if curl -fsS --max-time 20 "https://$HOST/health"; then
  printf '\n'
else
  printf '\n'
  warn "https://$HOST/health did not answer.
       The deploy itself succeeded. On a FIRST deploy the custom domain's
       certificate can take a few minutes — re-check before assuming a rollback.
       Otherwise: is the tier's \`routes\` entry uncommented in wrangler.jsonc?"
  exit 1
fi

step "Deployed $WORKER to $TIER"
