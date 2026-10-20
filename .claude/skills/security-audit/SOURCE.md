# Source

- Upstream: https://github.com/cloudflare/security-audit-skill
- Skill path: `skills/security-audit`
- Revision: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- Vendored: 2026-09-25
- License: MIT; see `LICENSE`.

The upstream skill files were copied without edits. `LICENSE` and this source
record were added alongside them.

**Local edits (2026-10-20): execution tiers.** Upstream allows target execution
only inside an OS-enforced sandbox and no deployed environment at all. This copy
adds two more tiers a project can designate, the developer host for its own
first-party code and a non-production staging deployment, and has the agent pick
the lowest tier that settles a question rather than stop at the sandbox. Production
stays out of every tier, and the sandbox stays mandatory for untrusted code. The
change is in `SKILL.md` (_Choosing the evidence_ replaces _Universal execution
safety_, plus the lines that referred to it) and in the agent prompts and
boundary lists of `HUNTING.md`, `VALIDATION-AND-REPORTING.md` and
`RECONNAISSANCE.md`. The promotion-procedure blocks, schema and validators are
unchanged. Carry these edits forward, or drop them deliberately, when replacing
this copy with a future upstream revision.
