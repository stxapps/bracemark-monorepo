# Codex setup

`AGENTS.md` directs Codex to the canonical
repository guidance in `CLAUDE.md`. Keep shared project rules in `CLAUDE.md` so
Claude Code and Codex use one source of truth.

Skills under `.agents/skills/` are relative symlinks
to their canonical implementations under `.claude/skills/`. Codex officially
supports symlinked skill folders, which keeps those workflows shared without
copying them.
