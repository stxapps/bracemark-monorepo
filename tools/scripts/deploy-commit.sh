#!/usr/bin/env bash
#
# Which commit is this deploy, and the tag that records it. SOURCED by
# tools/scripts/deploy-static.sh and tools/scripts/deploy-worker.sh — never run —
# so the two cannot drift on what a tag is called or when one is refused.
#
# WHY A TAG RATHER THAN A VERSION BUMP
#
# The four deployed apps carry no version: their package.json says 0.0.0 and
# nothing reads it (docs/architecture.md, _project versions_). What a deploy
# needs recorded is not a number somebody chose but the COMMIT that shipped, per
# app and per tier — eight independent histories that one `version` field per app
# could not hold. So each successful deploy leaves a tag:
#
#   deploy/<app>/<tier>/<utc time>      e.g. deploy/web/production/2026-10-13T091500Z
#
#   git tag -l 'deploy/web/production/*'         every production deploy of web
#   git diff <tag> HEAD -- apps packages         what is not out yet
#
# The tag is LOCAL. Nothing here pushes: publishing is the committer's call, and
# a second clone only sees the tag once it has been pushed and fetched. Each
# script therefore also writes the commit somewhere the deployed thing itself can
# be asked — see `record_deploy` in deploy-static.sh and the `--tag` on
# `wrangler deploy` in deploy-worker.sh.
#
# Expects from the caller: REPO_ROOT, APP, TIER, DRY_RUN, ALLOW_DIRTY, and the
# `die` / `warn` / `note` helpers.

# Sets DEPLOY_COMMIT (the full sha), DEPLOY_STAMP (twelve characters of it, plus
# `-dirty` when the tree is) and DEPLOY_DIRTY.
#
# A deploy builds the WORKING TREE, not HEAD, so a tag is only true when the two
# are the same thing. Untracked files count: a new source file is in the build
# whether or not git has heard of it. Ignored files do not, and that is the limit
# of the claim — the per-tier env files are ignored and are also inputs.
#
# Fatal on production, a warning on staging — the same split as `check_todo` in
# deploy-worker.sh, for the same reason: staging is where unfinished work is
# tried, and production is where "which commit is live" has to have an answer.
resolve_deploy_commit() {
  local changes
  command -v git >/dev/null 2>&1 || die "git not found — a deploy records the commit it ships"
  DEPLOY_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify --quiet 'HEAD^{commit}')" \
    || die "$REPO_ROOT has no commit to deploy from — a deploy records the commit it ships"
  DEPLOY_STAMP="${DEPLOY_COMMIT:0:12}"
  DEPLOY_DIRTY=false

  changes="$(git -C "$REPO_ROOT" status --porcelain)"
  if [ -z "$changes" ]; then
    note "commit: $DEPLOY_STAMP"
    return 0
  fi

  DEPLOY_DIRTY=true
  DEPLOY_STAMP="$DEPLOY_STAMP-dirty"
  note "commit: $DEPLOY_STAMP"
  warn "the working tree is not what $DEPLOY_COMMIT holds:"
  printf '%s\n' "$changes" | sed -n '1,10s/^/       /p' >&2
  [ "$(printf '%s\n' "$changes" | wc -l)" -le 10 ] || printf '       …\n' >&2

  if [ "$ALLOW_DIRTY" = true ]; then
    warn "continuing anyway (--allow-dirty) — this deploy will not be tagged"
    return 0
  fi
  # A --dry-run is a diagnostic — let it finish rather than stopping on the one
  # thing that cannot matter to a run that ships nothing.
  [ "$DRY_RUN" = false ] || return 0
  if [ "$TIER" != "production" ]; then
    warn "deploying it to $TIER untagged"
    return 0
  fi
  die "refusing to deploy uncommitted work to production. Commit it, or set it aside
       with 'git stash -u', or pass --allow-dirty to ship it untagged."
}

# Sets DEPLOY_AT and DEPLOY_TAG. Called immediately before the step that makes
# the deploy real, so the time in the name is when it shipped rather than when
# the preflight started. No colons: they are not legal in a ref name.
name_deploy() {
  DEPLOY_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  DEPLOY_TAG="deploy/$APP/$TIER/${DEPLOY_AT//:/}"
}

# Tag DEPLOY_COMMIT. Called only AFTER the deploy has landed, and never fatal:
# by then the thing is live, and a non-zero exit would report a failed deploy
# that did not fail.
tag_deploy() {
  if [ "$DEPLOY_DIRTY" = true ]; then
    note "not tagged: what shipped is not a commit ($DEPLOY_STAMP)"
    return 0
  fi
  # Lightweight, not annotated: an annotated tag needs an identity and may ask
  # to be signed, and neither is worth a prompt at the end of a deploy.
  if git -C "$REPO_ROOT" tag "$DEPLOY_TAG" "$DEPLOY_COMMIT" 2>/dev/null; then
    note "tagged: $DEPLOY_TAG → $DEPLOY_STAMP"
    note "local only — to share it: git push origin $DEPLOY_TAG"
  else
    warn "could not create the tag. The deploy itself succeeded; record it by hand:
       git tag $DEPLOY_TAG $DEPLOY_COMMIT"
  fi
}
