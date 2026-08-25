#!/usr/bin/env bash
#
# Deploy one of the two static-export Next apps to its S3 bucket and invalidate
# the CloudFront distribution in front of it.
#
#   tools/scripts/deploy-static.sh <web|site> <staging|production> [options]
#
# Normally reached through the root package.json aliases:
#
#   npm run deploy:web:staging      npm run deploy:web:production
#   npm run deploy:site:staging     npm run deploy:site:production
#
# Bucket names, the two tiers and the hosts they serve are fixed by
# docs/hosting.md, _naming conventions_ — keep the table below in step with it.
#
# WHY THIS SCRIPT BUILDS RATHER THAN JUST UPLOADING `out/`
#
# `NEXT_PUBLIC_API_URL` and friends are baked into the bundle at build time, so
# staging and production are genuinely different artifacts from the same commit
# and are never promoted (docs/hosting.md, _cors & frontend↔backend wiring_).
# A deploy script that only uploads whatever is sitting in `out/` will happily
# push a staging bundle — pointing at api.dryrunbase.com, with the Paddle
# sandbox token — to the production bucket, and nothing about the resulting site
# looks wrong until someone tries to sign in. So this script owns the build, and
# verifies the tier afterwards regardless of who built it (see `verify_tier`),
# which is also what makes `--skip-build` safe.
#
# Requires: aws-cli v2, and this tier's AWS credentials.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- Cache-Control ---------------------------------------------------------
#
# Three classes, keyed off the path/extension rather than a hand-maintained list
# of filenames — a list rots silently the first time someone adds an icon.
#
#   immutable  everything under `_next/` is content-hashed or build-ID-scoped
#              (`_next/static/chunks/…`, `_next/<buildId>/…`), so a given URL can
#              never change meaning. Cache forever, never delete (see below).
#   week       icons, social images, favicon — real files with stable names, so
#              a changed one needs the CloudFront invalidation to appear.
#   revalidate HTML, the `.txt` RSC payloads Next 16 emits beside it, sw.js,
#              manifest.json, robots.txt. These point at the hashed assets above,
#              so they must never be served stale.
readonly CACHE_IMMUTABLE="public, max-age=31536000, immutable"
readonly CACHE_WEEK="public, max-age=604800"
readonly CACHE_REVALIDATE="public, max-age=0, must-revalidate"

usage() {
  cat >&2 <<'USAGE'
Usage: deploy-static.sh <web|site> <staging|production> [options]

Options:
  --skip-build          Deploy the existing out/ instead of rebuilding.
                        The tier check still runs.
  --dry-run             Print what would sync; upload nothing, invalidate nothing.
  --no-invalidate       Skip the CloudFront invalidation (opt out explicitly).
  --no-wait             Create the invalidation but don't wait for it to finish.
  --distribution-id ID  Override the distribution id for this run.
  --yes, -y             Don't prompt before a production deploy.
  -h, --help            Show this message.

Environment:
  CLOUDFRONT_DISTRIBUTION_ID_<APP>_<TIER>   e.g. CLOUDFRONT_DISTRIBUTION_ID_WEB_PRODUCTION
  AWS_PROFILE / AWS_REGION                  passed through to the aws cli
USAGE
}

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# --- arguments -------------------------------------------------------------

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
[ "$#" -ge 2 ] || { usage; exit 1; }

readonly APP="$1"
readonly TIER="$2"
shift 2

case "$APP" in
  web|site) ;;
  *) die "unknown app '$APP' (expected 'web' or 'site')" ;;
esac
case "$TIER" in
  staging|production) ;;
  *) die "unknown tier '$TIER' (expected 'staging' or 'production')" ;;
esac

SKIP_BUILD=false
DRY_RUN=false
INVALIDATE=true
WAIT_FOR_INVALIDATION=true
ASSUME_YES=false
DISTRIBUTION_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true ;;
    --dry-run) DRY_RUN=true ;;
    --no-invalidate) INVALIDATE=false ;;
    --no-wait) WAIT_FOR_INVALIDATION=false ;;
    --distribution-id) shift; [ "$#" -gt 0 ] || die "--distribution-id needs a value"; DISTRIBUTION_ID="$1" ;;
    --yes|-y) ASSUME_YES=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$1'" ;;
  esac
  shift
done

readonly PROJECT="@stxapps/bracemark-$APP"
readonly APP_DIR="$REPO_ROOT/apps/bracemark-$APP"
readonly OUT_DIR="$APP_DIR/out"
readonly BUCKET="bracemark-$APP-$TIER"          # docs/hosting.md, _naming conventions_
readonly S3_URI="s3://$BUCKET"

# The build reads .env.staging via the target's `envFile`; production is what
# `next build` loads by itself from .env.production (docs/env-files.md).
if [ "$TIER" = "staging" ]; then
  readonly ENV_FILE="$APP_DIR/.env.staging"
  readonly OTHER_ENV_FILE="$APP_DIR/.env.production"
else
  readonly ENV_FILE="$APP_DIR/.env.production"
  readonly OTHER_ENV_FILE="$APP_DIR/.env.staging"
fi

# --- preflight -------------------------------------------------------------

command -v aws >/dev/null 2>&1 || die "aws cli not found — https://aws.amazon.com/cli/"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"

step "Deploying bracemark-$APP → $S3_URI ($TIER)"

if ! CALLER="$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null)"; then
  die "no usable AWS credentials (check AWS_PROFILE / aws configure)"
fi
note "aws account: $CALLER${AWS_PROFILE:+  (profile: $AWS_PROFILE)}"

# Credentials are scoped per tier, so the wrong ones may not reach this bucket at
# all. Failing here beats discovering it half-synced.
aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 \
  || die "bucket '$BUCKET' is not reachable from account $CALLER"

# Resolve the distribution id BEFORE anything is uploaded. Finding out it is
# missing after the syncs have run would leave the bucket updated and the CDN
# still serving the previous build.
if [ "$INVALIDATE" = true ] && [ "$DRY_RUN" = false ]; then
  if [ -z "$DISTRIBUTION_ID" ]; then
    APP_UPPER="$(printf '%s' "$APP" | tr '[:lower:]' '[:upper:]')"
    TIER_UPPER="$(printf '%s' "$TIER" | tr '[:lower:]' '[:upper:]')"
    VAR_NAME="CLOUDFRONT_DISTRIBUTION_ID_${APP_UPPER}_${TIER_UPPER}"
    eval "DISTRIBUTION_ID=\${$VAR_NAME:-}"
    [ -n "$DISTRIBUTION_ID" ] || die "\$$VAR_NAME is not set.
       Set it, pass --distribution-id, or pass --no-invalidate to skip on purpose."
  fi
  note "cloudfront: $DISTRIBUTION_ID"
fi

if [ "$TIER" = "production" ] && [ "$DRY_RUN" = false ] && [ "$ASSUME_YES" = false ]; then
  if [ ! -t 0 ]; then
    die "production deploy in a non-interactive shell — pass --yes if you mean it"
  fi
  printf '\n    This is \033[1mPRODUCTION\033[0m (%s). Type the bucket name to continue: ' "$BUCKET"
  read -r CONFIRM
  [ "$CONFIRM" = "$BUCKET" ] || die "aborted"
fi

# --- build -----------------------------------------------------------------

if [ "$SKIP_BUILD" = true ]; then
  step "Skipping build (--skip-build)"
  [ -d "$OUT_DIR" ] || die "$OUT_DIR does not exist — drop --skip-build"
else
  step "Building $PROJECT for $TIER"
  # `production` is the default configuration: .env.production is what plain
  # `next build` loads. Only staging needs to be named.
  if [ "$TIER" = "staging" ]; then
    (cd "$REPO_ROOT" && npx nx build "$PROJECT" --configuration=staging)
  else
    (cd "$REPO_ROOT" && npx nx build "$PROJECT")
  fi
fi

[ -f "$OUT_DIR/index.html" ] || die "$OUT_DIR/index.html missing — the export did not produce a site"

# --- the tier check --------------------------------------------------------
#
# The two tiers sit on different REGISTRABLE DOMAINS — bracemark.com vs
# dryrunbase.com (docs/hosting.md, _why staging is a separate registrable
# domain_) — and every NEXT_PUBLIC_*_URL is inlined into the bundle at build
# time. So the artifact carries proof of which tier it was built for, and a
# mis-tiered deploy is catchable before it lands.
#
# Keyed on the domain rather than a specific host on purpose: bracemark-site
# bakes NEXT_PUBLIC_APP_URL but never mentions api.* at all, so an api-host
# check would reject every site deploy. The discriminating domains are computed
# as the difference between the two env files, which means a shared third-party
# host added to both tiers (Paddle, say) is ignored automatically.

# Registrable domain of every NEXT_PUBLIC_*_URL in an env file.
env_domains() {
  sed -n 's|^[[:space:]]*NEXT_PUBLIC_[A-Z0-9_]*=https\{0,1\}://\([^/[:space:]]*\).*|\1|p' "$1" \
    | awk -F. 'NF>=2 { print $(NF-1)"."$NF }' \
    | sort -u
}

# Binary chunks under _next/static/media would only produce noise.
GREP_IN=( --include='*.js' --include='*.html' --include='*.txt' --include='*.json' )

verify_tier() {
  local want forbid d found
  want="$(comm -23 <(env_domains "$ENV_FILE") <(env_domains "$OTHER_ENV_FILE"))"
  forbid="$(comm -13 <(env_domains "$ENV_FILE") <(env_domains "$OTHER_ENV_FILE"))"

  if [ -z "$want" ]; then
    note "skipped: $ENV_FILE and $OTHER_ENV_FILE name no distinguishing domain"
    return 0
  fi

  found=false
  for d in $want; do
    if grep -rlF "${GREP_IN[@]}" -e "$d" "$OUT_DIR" >/dev/null 2>&1; then
      found=true
      note "ok: bundle references $d"
    fi
  done
  [ "$found" = true ] \
    || die "the build in out/ never mentions $(echo $want) — it is not a $TIER build.
       Rebuild without --skip-build."

  for d in $forbid; do
    if grep -rlF "${GREP_IN[@]}" -e "$d" "$OUT_DIR" >/dev/null 2>&1; then
      die "the build in out/ references '$d', which belongs to the other tier.
       Refusing to publish it to $BUCKET. Rebuild without --skip-build."
    fi
  done
}

step "Verifying the bundle is a $TIER build"
verify_tier

# --- sync ------------------------------------------------------------------
#
# Order matters: hashed assets go up BEFORE the HTML that references them, so a
# client that loads a fresh page mid-deploy can always resolve its chunks.

SYNC_FLAGS=( --no-progress )
[ "$DRY_RUN" = true ] && SYNC_FLAGS=( --no-progress --dryrun )

# .DS_Store is a real hazard here: apps/bracemark-web/public/.DS_Store gets
# copied into out/ by `next build` and would otherwise be published.
JUNK=( --exclude "*.DS_Store" )

# Anything not under `_next/` that a browser treats as an image. Ordering of the
# filters is significant — the aws cli applies them left to right, last match
# wins — so the `_next/*` exclusion comes last to keep hashed fonts and media
# out of this pass and in the immutable one above.
IMAGES=(
  --exclude "*"
  --include "*.png" --include "*.jpg" --include "*.jpeg" --include "*.gif"
  --include "*.svg" --include "*.webp" --include "*.avif" --include "*.ico"
  --exclude "_next/*"
)

# The inverse of the two passes above: HTML, the `.txt` RSC payloads, sw.js,
# manifest.json, robots.txt — everything whose content changes under a stable
# name.
DOCUMENTS=(
  --exclude "_next/*"
  --exclude "*.png" --exclude "*.jpg" --exclude "*.jpeg" --exclude "*.gif"
  --exclude "*.svg" --exclude "*.webp" --exclude "*.avif" --exclude "*.ico"
)

step "Syncing _next/ (immutable, 1 year)"
# No --delete: a client that loaded the previous build is still fetching its
# chunks by hash, and deleting them breaks navigation for anyone mid-session.
# Old builds accumulate, so expire them with an S3 lifecycle rule on `_next/`
# rather than here (docs/hosting.md, _deploying the static sites_).
# --size-only is safe precisely because these names are content-addressed.
aws s3 sync "$OUT_DIR/_next" "$S3_URI/_next" "${SYNC_FLAGS[@]}" \
  --size-only \
  "${JUNK[@]}" \
  --cache-control "$CACHE_IMMUTABLE"

step "Syncing images and icons (1 week)"
aws s3 sync "$OUT_DIR" "$S3_URI" "${SYNC_FLAGS[@]}" \
  --delete \
  "${IMAGES[@]}" \
  "${JUNK[@]}" \
  --cache-control "$CACHE_WEEK"

step "Syncing HTML, RSC payloads and manifests (must-revalidate)"
# Deliberately NOT --size-only: an edited page very often keeps its byte count.
aws s3 sync "$OUT_DIR" "$S3_URI" "${SYNC_FLAGS[@]}" \
  --delete \
  "${DOCUMENTS[@]}" \
  "${JUNK[@]}" \
  --cache-control "$CACHE_REVALIDATE"

# --- invalidate ------------------------------------------------------------

if [ "$DRY_RUN" = true ]; then
  step "Dry run — nothing was uploaded and no invalidation was created"
  exit 0
fi

if [ "$INVALIDATE" = false ]; then
  step "Skipping CloudFront invalidation (--no-invalidate)"
  note "the 1-week assets and any changed HTML will serve stale until the TTL expires"
  exit 0
fi

step "Invalidating CloudFront $DISTRIBUTION_ID"
# `/*` counts as a single path against the free tier, and re-fetching an
# immutable asset costs one conditional request, so there is nothing to gain
# from a narrower path list.
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths '/*' \
  --query 'Invalidation.Id' --output text)"
note "invalidation: $INVALIDATION_ID"

if [ "$WAIT_FOR_INVALIDATION" = true ]; then
  note "waiting for it to complete (usually under 3 minutes; --no-wait to skip)"
  aws cloudfront wait invalidation-completed \
    --distribution-id "$DISTRIBUTION_ID" --id "$INVALIDATION_ID"
fi

step "Deployed bracemark-$APP to $TIER"
