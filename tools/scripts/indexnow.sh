#!/usr/bin/env bash
#
# Tell the IndexNow engines (Bing, Yandex, Seznam, Naver, Yep — not Google)
# that marketing-site URLs on bracemark.com changed.
#
#   tools/scripts/indexnow.sh <url>...        the pages a deploy added or changed
#   tools/scripts/indexnow.sh --sitemap       every URL in the LIVE sitemap
#   tools/scripts/indexnow.sh --dry-run ...   print the payload, send nothing
#
# Run it AFTER a production deploy, never before: the engines fetch the URLs
# (and the key file) as soon as they accept the ping. `--sitemap` is for the
# first submission and after a URL-wide change; resubmitting unchanged pages on
# every deploy is what IndexNow asks sites not to do (docs/hosting.md, _IndexNow
# — the key file_).
#
# The key is public by design — it is served at KEY_LOCATION below — so it is
# an identifier, not a credential, and belongs in the tree.

set -euo pipefail

readonly HOST="bracemark.com"
readonly KEY="4526d3eed555a40d30186c50dd8608d7"
readonly KEY_LOCATION="https://$HOST/$KEY.txt"
readonly ENDPOINT="https://api.indexnow.org/indexnow"
readonly MAX_URLS=10000

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

command -v jq >/dev/null || die "jq is required"

DRY_RUN=false
SITEMAP=false
URLS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --sitemap) SITEMAP=true ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) URLS+=("$arg") ;;
  esac
done

if [ "$SITEMAP" = true ]; then
  [ ${#URLS[@]} -eq 0 ] || die "pass --sitemap or URLs, not both"
  step "Reading https://$HOST/sitemap.xml"
  while IFS= read -r url; do URLS+=("$url"); done < <(
    curl -fsS --max-time 20 "https://$HOST/sitemap.xml" \
      | grep -o '<loc>[^<]*</loc>' | sed -e 's/<loc>//' -e 's/<\/loc>//'
  )
fi
[ ${#URLS[@]} -gt 0 ] || die "no URLs — pass some, or --sitemap"
[ ${#URLS[@]} -le $MAX_URLS ] || die "${#URLS[@]} URLs; IndexNow takes at most $MAX_URLS per request"

# The endpoint rejects the whole batch (422) when one URL is off-host, so catch
# it here with the URL named rather than after the round trip.
for url in "${URLS[@]}"; do
  case "$url" in
    "https://$HOST" | "https://$HOST/"*) ;;
    *) die "not a https://$HOST URL: $url" ;;
  esac
done

PAYLOAD="$(printf '%s\n' "${URLS[@]}" | jq -R . | jq -s -c \
  --arg host "$HOST" --arg key "$KEY" --arg loc "$KEY_LOCATION" \
  '{host: $host, key: $key, keyLocation: $loc, urlList: .}')"

if [ "$DRY_RUN" = true ]; then
  step "Dry run — ${#URLS[@]} URL(s), nothing sent"
  printf '%s\n' "$PAYLOAD" | jq .
  exit 0
fi

# A missing or stale key file makes the engines answer 403 — but some accept
# first and verify later, so a wrong file can fail with no error here at all.
step "Checking $KEY_LOCATION"
served="$(curl -fsS --max-time 10 "$KEY_LOCATION")" \
  || die "key file not reachable — deploy the marketing site first"
[ "$served" = "$KEY" ] || die "key file is served but does not hold KEY"

step "Submitting ${#URLS[@]} URL(s) to $ENDPOINT"
status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json; charset=utf-8' --data "$PAYLOAD")"
case "$status" in
  200 | 202) note "$status — accepted (202: key not verified yet; that's normal the first time)" ;;
  400) die "400 — malformed request" ;;
  403) die "403 — key not valid for $HOST (is $KEY_LOCATION live?)" ;;
  422) die "422 — a URL does not belong to $HOST, or the key does not match" ;;
  429) die "429 — too many requests; looks like spam to the endpoint, back off" ;;
  *) die "unexpected HTTP $status" ;;
esac
