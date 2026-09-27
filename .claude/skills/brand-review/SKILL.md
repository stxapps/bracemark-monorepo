---
name: brand-review
description: Review Bracemark copy against the brand voice, the terminology rules and the claim boundary in docs/brand-assets.md — flagging deviations by severity with before/after fixes, and screening for claims the architecture does not support. Use before shipping marketing-site prose, store-listing copy, an in-app string or an error message. Vendored from anthropics/knowledge-work-plugins (Apache-2.0, `marketing/skills/brand-review`) and adapted; `docs/` wins on conflict.
argument-hint: "<content, file path, or nothing to review the working tree's copy changes>"
version: 1.0.0
license: Apache-2.0
---

# Brand review

> **Vendored from [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)
> (Apache-2.0, `marketing/skills/brand-review`), 2026-08-23.** The upstream skill
> carries a generic brand-voice framework and asks the user for their guidelines.
> This copy replaces that framework with **this repo's** guidelines, which are
> already written, and drops the parts that contradict them — the upstream advice
> to write "benefit-driven" headlines and quantified outcome claims is exactly the
> register `docs/brand-assets.md` bars. What survives is the review procedure: the
> dimensions, the severity scale, the before/after output, and the compliance pass.

## The guidelines are a file, not a question

**Never ask the user what their brand voice is.** Read these first, every time —
they are the source of truth and they are more specific than anything this skill
could infer:

| read                                         | for                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docs/brand-assets.md` — _the voice_         | the four voice attributes, tone by surface, the error shape, the mechanics, the terminology |
| `docs/brand-assets.md` — _the brand lines_   | descriptor / tagline / slogan / subtitle, and the rule that they are never substituted      |
| `docs/brand-assets.md` — _the two nouns_     | bookmark vs. link, per surface; why "vault" and "library" are barred as labels              |
| `docs/brand-assets.md` — _the source_        | the claim boundary: "see for yourself what we do", never "verify what you are running"      |
| `packages/shared/src/stores/listing-copy.ts` | the shipped strings, their character budgets, and the copy rule (only promise what ships)   |
| `docs/accessibility.md`                      | whether an error string needs `role="alert"` and which carrier provides it                  |

If the content under review is an in-app string, also read the doc that owns its
area (`docs/editors.md`, `docs/account.md`, `docs/iap.md`, `docs/locks.md`) —
several of them rule on specific words.

**Then the overlay, if there is one.** If `local.md` exists beside this file, read
it and follow it. It is gitignored and per clone — context that cannot be public —
so it is often absent, and the review stands without it. Nothing it contains goes
into a file this repo tracks: findings still cite `docs/brand-assets.md` sections,
never the overlay or anything it points to.

## Inputs

Accept the content as: pasted text, a file path, a URL, or **nothing** — with no
argument, review the copy changed in the working tree (`git diff` plus untracked
files), restricted to user-facing strings and prose. Skip code comments; they are
not held to the voice.

## What to check

### 1. Voice

Against the four attributes in _the voice_. For each, the failure is the
"We are not" line, so look for those specifically:

- **Mechanical** — flag any adjective claiming intent rather than naming a
  mechanism: "privacy-focused", "private & secure", "bank-grade", "safe with us",
  "trusted". High severity: these contradict the slogan on the same page.
- **States its own costs** — on any surface long enough to make the case, check
  that the costs are on it (no password reset, on-device search, no shared lists)
  and not relegated. Flag their absence, which is the failure this attribute has.
- **Second person, plain** — flag exclamation marks, "Oops"/"Whoops", jokes,
  third-person "users", and passive constructions where the user is the actor.
- **First person plural** — flag "Bracemark" as the subject of a sentence about a
  promise, a cost or a failure; that is a "we" sentence.

### 2. Tone against the surface

Identify which row of the _tone by surface_ table the content is, then check the
register matches. The common miss is hero-register argument (a claim plus three
supporting clauses where the surface allows one sentence) and its inverse, a
one-line assertion on /about where the reader came to read the argument.

### 3. Errors

If the content is an error string, hold it to the fixed shape:

- Unactionable → `Could not ⟨the user's own verb⟩. Please try again.` — subject is
  us, no code, no "Something went wrong".
- Actionable → name what was wrong, then the act.
- Check the platform verb (**click** on web, **tap** on expo).
- Check it mounts inside a carrier that provides `role="alert"`; a bare `<p>` with
  no role is a **high**-severity finding even though the wording is fine.

### 4. Terminology and mechanics

Run the two tables in _the voice_ and the table in _the two nouns_ literally:

- link vs. bookmark, per surface — the most common real error
- bare "extension" — always a finding; qualify browser or share
- "vault" / "library" as a label; the collection gets no noun
- sentence case, spaced em dash, serial comma, contractions, the `’` apostrophe
- typed plan names, prices, caps or trial lengths — these are read from
  `PLAN_LABELS` / `iap/plans`, and store copy carries no numbers at all

### 5. Claims (always checked)

This product's copy has one failure mode worse than being off-voice: **claiming
something the architecture does not support.** Flag as high severity:

- **Beyond the claim boundary** — any wording that lets a reader think they can
  verify the build they were served ("verify", "provably", "audited"). Public
  source proves what the code does, not which build was served.
- **Unshipped features** — read mode, screenshots, page copies and AI are planned.
  `listing-copy.ts` keeps the list; _only what ships_ in `docs/brand-assets.md`
  is the rule, and it binds every string a user reads — the marketing site, and a
  tool's output such as the bookmark converter's receipt and errors.
- **Numbers that can go stale** — a cap, a price, a trial length written as a
  literal rather than read from `iap/plans`. In store copy, a number at all.
- **Superlatives and competitor comparisons** — "the only", "the most secure",
  and competitor trademarks. In an App Store keyword field the last one is a
  rejection (guideline 2.3.7), not a style note.
- **Other mobile platforms named in store copy** — guideline 2.3.10; browsers are
  fine.
- **Legal surfaces** — /terms and /privacy name `COMPANY` from `listing-copy.ts`;
  a claim about what we collect must be checkable against `docs/local-first-sync.md`.

## Output

### Summary

Two or three sentences: does this read as Bracemark, and what is the single most
important fix.

### Findings

| issue | location | severity | fix |

- **High** — contradicts the voice's central argument, claims something the
  architecture does not support, breaks a terminology rule that ships to a store,
  or drops `role="alert"`.
- **Medium** — off-register for the surface, wrong noun, a mechanics rule broken
  in prose a user reads.
- **Low** — a preference within the rules.

Cite the rule by its section name (_the voice_, _the two nouns_, _the source_)
rather than restating it, so the user can check the call against the file.

### Rewrites

For the top three to five findings, the original line and a replacement. Write the
replacement in the voice — do not hedge it into neutrality, which is the usual way
a rewrite loses the thing that made the copy Bracemark's.

### Where it also has to change

Copy in this repo is frequently duplicated across platforms — a web string and its
expo twin, `listing-copy.ts` and the marketing site. When a finding lands on one
of a pair, grep for the twin and list it. A fix applied to one half is the failure
mode this whole file exists to prevent.

## After the review

Offer: apply the high-severity fixes; apply all of them; or, if the review turned
up a rule that is being kept in practice but is not written down, add it to
`docs/brand-assets.md` — that file is the only thing enforcing any of this, so a
rule discovered during a review belongs in it before the next one.
