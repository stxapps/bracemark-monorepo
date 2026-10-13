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
# could not hold. So each successful PRODUCTION deploy leaves a tag:
#
#   <app>/<utc date>-<utc time>         e.g. web/20261013-091500
#
#   git tag -l 'web/*'                           every production deploy of web
#   git diff <tag> HEAD -- apps packages         what is not out yet
#
# The name is short on purpose: it is read in a git client's ref column, where a
# long one is cut off. So it says neither "deploy" nor "production" — a tag
# under one of the four app names IS a production deploy, by this convention and
# nothing else. Keep every other tag out of those four namespaces
# (DEPLOY_TAG_PATTERNS below).
#
# The tag is then PUSHED to `origin`. A step left to memory is a step that gets
# skipped, and a tag that never leaves this clone is a history the other clone
# cannot see. Two limits, both in `push_deploy_tags`: only once `origin` has the
# commit, and never fatally — so a tag can still be local for a while. Each
# script therefore also writes the commit somewhere the deployed thing itself can
# be asked — see `record_deploy` in deploy-static.sh and the `--tag` on
# `wrangler deploy` in deploy-worker.sh.
#
# STAGING IS NOT TAGGED, and that second record is all it gets. A staging tag
# history could never be trusted to be complete — a dirty tree deploys there,
# untagged, and staging is exactly where uncommitted work is tried — while the
# deployed thing's own answer covers every deploy, dirty ones included, from any
# clone. What only a tag can answer — what was live before, what to roll back to,
# what is not out yet — are production questions.
#
# Expects from the caller: REPO_ROOT, APP, TIER, DRY_RUN, ALLOW_DIRTY, PUSH_TAGS,
# and the `die` / `warn` / `note` helpers.

# Every deploy tag there is, whichever script made it: the two static apps and
# the two Workers. A tag matching one of these is taken to be a production deploy.
readonly DEPLOY_TAG_PATTERNS=('web/*' 'site/*' 'api/*' 'extractor/*')

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
    warn "deploying it to $TIER anyway"
    return 0
  fi
  die "refusing to deploy uncommitted work to production. Commit it, or set it aside
       with 'git stash -u', or pass --allow-dirty to ship it untagged."
}

# Sets DEPLOY_AT, DEPLOY_TAG and DEPLOY_UNTAGGED. Called immediately before the
# step that makes the deploy real, so the time in the name is when it shipped
# rather than when the preflight started. The tag carries DEPLOY_AT with its
# punctuation dropped (`2026-10-13T09:15:00Z` → `20261013-091500`): still UTC,
# still sorting in deploy order. The seconds stay because a Worker deploys in
# under a minute, and two deploys of one app must not want the same name.
#
# Exactly one of DEPLOY_TAG and DEPLOY_UNTAGGED is non-empty: the tag this deploy
# will get, or why it gets none. Callers that write the tag's name elsewhere —
# `/deploy.json`, the Worker version's message — key off DEPLOY_TAG, so they
# never name a tag that does not exist.
name_deploy() {
  local stamp
  DEPLOY_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  DEPLOY_TAG=""
  DEPLOY_UNTAGGED=""
  if [ "$DEPLOY_DIRTY" = true ]; then
    DEPLOY_UNTAGGED="dirty tree"
  elif [ "$TIER" != "production" ]; then
    DEPLOY_UNTAGGED="$TIER"
  else
    stamp="${DEPLOY_AT//[-:Z]/}"
    DEPLOY_TAG="$APP/${stamp/T/-}"
  fi
}

# Tag DEPLOY_COMMIT. Called only AFTER the deploy has landed, and never fatal:
# by then the thing is live, and a non-zero exit would report a failed deploy
# that did not fail.
tag_deploy() {
  if [ -z "$DEPLOY_TAG" ]; then
    note "not tagged ($DEPLOY_UNTAGGED): $DEPLOY_STAMP"
    return 0
  fi
  # Lightweight, not annotated: an annotated tag needs an identity and may ask
  # to be signed, and neither is worth a prompt at the end of a deploy.
  if git -C "$REPO_ROOT" tag "$DEPLOY_TAG" "$DEPLOY_COMMIT" 2>/dev/null; then
    note "tagged: $DEPLOY_TAG → $DEPLOY_STAMP"
  else
    warn "could not create the tag. The deploy itself succeeded; record it by hand:
       git tag $DEPLOY_TAG $DEPLOY_COMMIT"
  fi
}

# Push the deploy tags `origin` can take. Called once the deploy needs nothing
# more from this script — a push that stalls must not be standing between an
# updated bucket and its invalidation — and never fatal, like `tag_deploy`.
#
# ONLY TAGS WHOSE COMMIT `origin` ALREADY HAS. Pushing a tag uploads the commit
# it points at, so a deploy made from unpushed commits would publish them — to a
# public repo, ahead of the push that was going to — as a side effect of
# deploying. "Already has" is read from this clone's remote-tracking branches,
# without a fetch: they are as fresh as the last push or fetch made here, and a
# stale one only holds a tag back.
#
# That is also why this pushes EVERY such tag of the four apps and not just the
# new one: a tag held back because its commit was not out yet, or because a push
# failed, goes out with the next production deploy of anything. Pushing a tag
# `origin` already has is a no-op.
#
# GIT_TERMINAL_PROMPT=0: a missing credential fails here rather than asking for
# one at the end of a deploy.
push_deploy_tags() {
  local ref tag out new count=0 mine=false
  local -a refspecs=()
  [ -n "$DEPLOY_TAG" ] || return 0
  if [ "$PUSH_TAGS" = false ]; then
    note "not pushed (--no-push) — the next production deploy pushes it, or:"
    note "  git push origin $DEPLOY_TAG"
    return 0
  fi

  while IFS= read -r tag; do
    if [ -n "$tag" ]; then
      refspecs+=("refs/tags/$tag")
      count=$((count + 1))
      if [ "$tag" = "$DEPLOY_TAG" ]; then mine=true; fi
    fi
  done < <(
    git -C "$REPO_ROOT" for-each-ref --format='%(refname)' refs/remotes/origin 2>/dev/null \
      | while IFS= read -r ref; do
          git -C "$REPO_ROOT" tag --merged "$ref" -l "${DEPLOY_TAG_PATTERNS[@]}" 2>/dev/null
        done \
      | sort -u
  )

  # Skipped when the tag itself was never made: `tag_deploy` has said so already.
  if [ "$mine" = false ] \
    && git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/tags/$DEPLOY_TAG" >/dev/null; then
    note "not pushed: origin does not have $DEPLOY_STAMP yet, and the tag would publish it."
    note "  the next production deploy pushes it once the commit is there, or:"
    note "  git push origin $DEPLOY_TAG"
  fi
  [ "$count" -gt 0 ] || return 0

  # --porcelain: one `<flag> <from>:<to> <summary>` line per ref, `*` for a ref
  # the remote did not have.
  if out="$(GIT_TERMINAL_PROMPT=0 git -C "$REPO_ROOT" push --porcelain origin "${refspecs[@]}" 2>&1)"; then
    new="$(printf '%s\n' "$out" | sed -n 's|^\*[[:space:]]refs/tags/\([^:]*\):.*|\1|p')"
    if [ -n "$new" ]; then
      printf '%s\n' "$new" | while IFS= read -r tag; do note "pushed: $tag → origin"; done
    fi
  else
    warn "could not push the deploy tags to origin. The deploy itself succeeded."
    printf '%s\n' "$out" | sed -n '1,5s/^/       /p' >&2
    if [ "$mine" = true ]; then
      note "the next production deploy retries, or: git push origin $DEPLOY_TAG"
    fi
  fi
}
