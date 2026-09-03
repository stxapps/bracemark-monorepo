#!/usr/bin/env bash
# PreToolUse guard. Two jobs, in this order.
#
# 1. SECRETS. This replaces the three Read() deny rules that used to sit in
#    .claude/settings.json. Those rules were correct but unusable: a deny rule
#    pointing INSIDE the repo makes the permission checker refuse every
#    pathless search, because it resolves a bare `rg` to '.', sees that '.'
#    contains a denied path, and cannot model .gitignore. As of Claude Code
#    2.1.259 that fires even on an `rg` reading stdin in a pipeline, which
#    touches no files at all. A PreToolUse hook cannot re-grant it either --
#    permissions.deny outranks permissionDecision:"allow" by design, verified
#    live. So the paths are enforced here instead: that costs the
#    harness-level guarantee and buys back repo-wide search.
#
# 2. SEARCH HYGIENE. The rules in CLAUDE.md, "Searching". They were prose for
#    a while and were followed in 13 of 826 calls: CLAUDE.md is read by the
#    model, while the prompt is decided by the harness before the model acts,
#    so prose can only nudge which command gets typed. A rejection reason from
#    here lands at the moment it matters.
#
# Fails OPEN: a missing jq or an unparseable payload exits 0 with no decision,
# so a broken guard can never block work. That is the trade-off accepted when
# the deny rules moved here -- keep this script boring and dependency-free.
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat) || exit 0
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)
fpath=$(printf '%s' "$payload" |
  jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // ""' 2>/dev/null)

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Secrets. All three are gitignored (.gitignore:117, :87, :104), so rg and
#    git grep already skip them; this stops the tools that don't.
# ---------------------------------------------------------------------------
# The credentials arm deliberately matches the bare directory too, not just a
# file under it, so that naming the directory at all is refused. Only *.local
# env files are secret -- .env and .env.example are tracked templates.
secret='(apps/bracemark-expo/credentials([^[:alnum:]]|$)|apps/bracemark-expo/android/gradle\.properties|\.env[^/[:space:]]*\.local)'
secret_msg="That path holds live credentials (apps/bracemark-expo/credentials/, any .env*.local, or apps/bracemark-expo/android/gradle.properties). It is gitignored and off limits to tooling; it was covered by a Read() deny rule in .claude/settings.json until that rule moved into tools/claude-hooks/pretooluse-guard.sh, because a deny rule pointing inside the repo made every pathless search prompt. If you genuinely need a value from it, ask the user rather than reading the file."

if [ -n "$fpath" ] && printf '%s' "$fpath" | grep -qE "$secret"; then
  deny "$secret_msg"
fi

if [ -n "$cmd" ] && printf '%s' "$cmd" | grep -qE "$secret"; then
  deny "$secret_msg"
fi

# Everything below is about shell commands only.
[ "$tool" = "Bash" ] || exit 0
[ -n "$cmd" ] || exit 0

# Blank out quoted regions, so a '|', ';' or '-u' inside a pattern ("a|b",
# "foo -u bar") is never mistaken for shell syntax or for a flag.
skel=$(printf '%s' "$cmd" | sed -E "s/'[^']*'/''/g; s/\"[^\"]*\"/\"\"/g")

# A search tool invoked at the start of the line or of a compound segment.
seg='(^|[;&|`(][[:space:]]*)'
search='(rg|grep|egrep|fgrep|find|git[[:space:]]+grep)[[:space:]]'

# ---------------------------------------------------------------------------
# 2. Search hygiene.
# ---------------------------------------------------------------------------

# 2a. A `cd` prefix makes the working directory indeterminate, so a relative
#     argument after it cannot be resolved -- and the cwd already persists
#     between calls, so it buys nothing.
if printf '%s' "$skel" | grep -qE '^[[:space:]]*cd[[:space:]]' &&
  printf '%s' "$skel" | grep -qE "${seg}${search}"; then
  deny "Don't prefix a search with 'cd'. It makes the working directory indeterminate, so a relative path after it can't be resolved. Every Bash call already starts in the project root and the cwd persists between calls, so the cd buys nothing: drop it and pass the path as an argument (rg -l pat some/dir)."
fi

# 2b. A recursive grep walks the tree without honouring .gitignore, which is
#     the only thing keeping a search away from the paths in section 1.
if printf '%s' "$skel" | grep -qE "${seg}(grep|egrep|fgrep)[[:space:]]+(-[[:alnum:]]*[rR]|--recursive|--include)"; then
  deny "Use 'rg' or 'git grep' instead of a recursive grep. A recursive grep does not honour .gitignore, so it reads the credentials and .env*.local files that section 1 of this guard protects, and it never names them so nothing else can catch it. rg honours .gitignore and git grep only reads tracked content. Non-recursive 'grep pattern file' on a named file is fine."
fi

# 2c. The flags that opt back out of .gitignore. A bundled -u counts: -u is
#     --no-ignore, -uu adds --hidden. --hidden alone still honours .gitignore.
#     Scoped to the rg segment: [^|;&]* cannot cross a pipe, so the 'sort -u'
#     in `rg pat file | sort -u` is not mistaken for rg's own -u.
unignore='(-[[:alnum:]]*u|--no-ignore(-vcs|-dot|-parent|-global|-files)?)'
if printf '%s' "$skel" | grep -qE "${seg}rg[[:space:]]+[^|;&]*${unignore}([[:space:]]|$)" ||
  printf '%s' "$skel" | grep -qE "${seg}git[[:space:]]+grep[[:space:]][^|;&]*--no-index"; then
  deny "'rg -u' / 'rg -uu' / 'rg --no-ignore' / 'git grep --no-index' opt back out of .gitignore, which is the only reason those searches are safe here. Drop the flag, or name the specific file you need. ('rg --hidden' on its own still honours .gitignore and is fine.)"
fi

exit 0
