## brand assets — the lines, the voice, the words, the claims, the account

The **rules for everything we say**, kept consistent across the marketing site,
the four apps, the store listings, the docs, the blog, and the one social
account: the three brand lines, the voice everything else is written in, the
mechanics and terminology that keep a string matching the last two hundred, the
two nouns the product uses for what it stores, what the public repo entitles us
to claim, and the account we hold. What we draw — the mark, the lockup, the 45°
fold, the generated pictures, the store screenshots — is in
[brand-visuals.md](./brand-visuals.md).

Every rule here is enforced by nothing but this file, except where a section says
a spec or a lint rule holds it. A paragraph in the wrong register type-checks,
lints and ships, so a change to a rule is a multi-file change that only this page
will remind you of.

Companions: [hosting.md](./hosting.md) for the origins the brand is served from,
[architecture.md](./architecture.md#apps) for what bracemark-site is, and
[brand-visuals.md](./brand-visuals.md) for the pictures.

### the brand lines

**Three lines, three jobs, never substituted for each other.** They live in
`packages/shared/src/brand/brand.ts` because five consoles and three apps have to
agree and nothing else enforces that. Not in `stores/listing-copy.ts` next door:
a store listing is only one of their consumers, and Settings → About, the
marketing site and the app chrome are the others.

| line           | text                                                   | for                                                                      |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| **descriptor** | End-to-end encrypted bookmark manager                  | directories, categories, any surface that supplies no context of its own |
| **tagline**    | The bookmark manager that can't read your bookmarks    | hero, OG title, X bio, press                                             |
| **slogan**     | We don't promise not to look. We built it so we can't. | sign-offs, ads, the inverted band                                        |

The tagline is the asset: it names the category and the mechanism in one clause
and states the mechanism as an **inability rather than an intention**, which no
competitor holding plaintext can copy. Its one weakness is that "can't read" can
momentarily parse as _broken_ rather than _blind_, so it is safest where
supporting copy resolves it immediately — which is why the ~30-character store
fields get a fourth line instead: **"Links encrypted on your device"**. The
listing name already supplies the bookmark category; the shorter line uses the
product's object noun and names the mechanism. It replaced "Bookmarks only you
can read", whose noun phrase could still be taken at a glance as an instruction
to save only what you have time to read — grammatically avoidable, commercially
real on a surface read that quickly.

**Adjectives are the failure mode here, not a missing feature.**
"Privacy-focused", "private & secure" and the rest are claims about intent, in a
product whose whole argument is that intent is worthless — putting them next to
"we don't promise not to look" contradicts it out loud. Prose says the mechanism
("a path, a size, a timestamp, and bytes we hold no key to open").

**The signature panel is a fourth thing in that file, and it is not a line.**
`SIGNATURE` holds the strings of the hero's two-halved panel — what you see, and
what we store: both eyebrows, the chip on the seam, the stored record (a path, a
size, when it last changed, a block of ciphertext), and the one sentence under it
that says the panel in words. `HeroPanel` in
`apps/bracemark-site/src/components/hero-panel.tsx` draws it and argues every
value — on the landing page's hero and, through `<SignaturePanel />`, on the
`/docs` page about encryption, which is one component so that there is one
inventory;
`tools/scripts/check-assets.ts` prints it for any picture that draws the same
object. It is in `brand.ts` for the three lines' reason, with a sharper failure:
the record is an **inventory**, and the panel has already shipped a short one — a
path and a size, over a caption that closed the list, while /privacy named the
timestamp too. A second drawing typed from the first keeps whichever inventory
was current the day it was copied.

Two rules come with it. **A drawing takes the record whole**: the three readable
fields are the concession as much as the ciphertext is the claim, and a version
that shows only the bytes is the "sees nothing" error with a picture where the
sentence was. And **the record is never read out as a bare list**. Under its
eyebrow, with the specimen above it, the panel scopes itself to one link; lifted
into running text — an alt text, a caption — the same four items after a colon
are a closed enumeration of what a server holds. `SIGNATURE.caption` is the form
that survives the move, because it also names what is _not_ held.

**The inventory is the same four items in prose, on every surface that lists
it**: a path, a size, a timestamp, and the bytes. The store descriptions, /about
and the repository's README all carried "a path, a size, and bytes" after the
panel had been corrected — true, scoped, and one field short, which is the
panel's own old fault in a sentence. `listing-copy.spec.ts` pins the three store
strings to the full list; /about and the README are held by this paragraph.

### the voice

The three lines above are what we say where a surface gives us one sentence. This
is how everything **else** is written — the marketing site's prose, an FAQ answer,
a button, an empty state, the sentence a failed request puts on screen. It is the
same kind of rule as the two nouns below and carries the same warning: nothing
enforces a word of it, and a paragraph in the wrong register type-checks, lints
and ships.

**Four attributes.** Each is stated with the misreading it invites, because the
misreadings are what actually happen — "plain" drifts into slack, "we" drifts
into corporate.

**Mechanical — describe the machine, never our intentions.**

- **We are**: specific about what the software does and precisely what our servers
  hold.
- **We are not**: reassuring. "Privacy-focused", "bank-grade", "your data is safe
  with us" are claims about intent, in a product whose whole argument is that
  intent is worth nothing beside architecture. Putting one next to _"we don't
  promise not to look"_ contradicts it out loud.
- **Sounds like**: "A path, a size, a timestamp, and bytes we hold no key to
  open. Not the title, not the address, not the tags." (the home page's inverted
  half). Note the completed verb: the compressed "bytes we hold no key **for**"
  shipped for a stretch and read as vague — a stranded preposition makes the
  reader invert the clause to find the claim in it.
- **Does not sound like**: "Your bookmarks are private and secure."

**The mirror of that rule is naming an enemy, and it fails the same way.**
"Bracemark exists to prevent the exploitation of your behaviour and interests" is
"privacy-focused" with the intent moved to the other party — a purpose we assert,
in a product whose case is that a purpose is worth nothing beside an
architecture. It also claims more than the machine does: we can keep
`api.bracemark.com` out of your library, and we cannot stop the sites you visit,
your browser or your ISP from assembling the same picture — `bracemark-extractor`
is handed a plaintext URL whenever the opt-in is on
([link-extraction-server.md](./link-extraction-server.md)). That makes
"prevent" the true-subset-as-the-whole error the privacy claims were rewritten to
avoid, in the one direction a reader can falsify from their own browsing. And it
buys a category the property has otherwise stayed out of, for the same reason two
words of set dressing came out of the hero specimen
(`apps/bracemark-site/src/app/page.tsx`, the tag row): the name of an -ism
recruits a whole genre, and the argument moves from what our server holds, which
is checkable, to a critique of an industry, which is not.

**The harm underneath it is real, and is already stated three times — each time
as a fact rather than as a cause.** /about opens on it ("what you are reading,
buying, worrying about, and working on"); the hero specimen assembles that picture
in front of the reader out of two topic tags and a weekday; the landing band's
"No ads, ever" carries the investor clause that says why the policy can hold.
There is no fourth surface missing. If one is ever wanted it is descriptive and
bounded to our own server — "a list of what you save is a list of what you want;
we hold bytes we have no key to open" — and it is never a sentence about why we
exist.

**States its own costs, unprompted.** The distinctive one, and the one most
easily edited out by someone tidying.

- **We are**: willing to spend a section arguing against the product.
  `FULL_DESCRIPTION` ends on "WHAT IT COSTS TO BUILD IT THIS WAY"; /about carries
  the same heading in prose; the create-account ceremony says saving the recovery
  code is "genuinely on you".
- **We are not**: modest, and not hedging. The concession is load-bearing: every
  other claim on the page is one the reader has no way to check, made by the party
  who benefits, and the costs are the only part of it they can verify against
  their own use.
- **The rule**: any surface long enough to make the case must also say what the
  architecture costs — no password reset, search that runs on the device, no
  shared or public lists. Not relegated to /faq.
- **On a surface too short for that** — a social post, a caption — one test
  decides: a cost goes in only if the line would mislead without it, or the
  reader will meet it by doing what the line says. "Turn off your connection"
  brings "opening a link's live page still needs one", because the first tap
  fails; a claim that the library outlasts us on the web brings "a browser can
  clear that copy". Any other cost waits for the page the post links to, or for
  a post of its own. Short excuses the cost from that line, not from being said.
- **Scope is not a cost.** "On a signed-in device" and "the links it has synced"
  are what make a sentence true, so they stay at any length. Narrow the claim
  before adding a caveat: a tighter claim often needs none.

**Second person, present tense, ordinary words.**

- **We are**: writing to one person doing one thing.
- **We are not**: casual. No exclamation marks, no "Oops", no jokes; the register
  is plain, not chatty.
- **Sounds like**: "Archive a link when you are done with it — it leaves My List
  but stays saved." / "Save a link and it lands here."
- **Does not sound like**: "Users can leverage the archive to keep their library
  tidy!"

**First person plural, and it takes the blame.**

- **We are**: a "we" that owns the mechanism and owns the failure. "We hold no
  key." "We cannot look, so we cannot be asked to." "Could not sign in."
- **We are not**: a "Bracemark" that refers to itself in the third person in
  running prose. The name is the subject where the sentence is about the product
  ("Bracemark is a bookmark manager that cannot read your bookmarks"); "we" is the
  subject where it is about the people running it, and that is every sentence
  about a promise, a cost, or a mistake.

#### tone by surface

The four attributes hold everywhere. What moves is how much room there is to
argue, and the register follows the room rather than the channel.

| surface                                | tone                                                                   | specimen                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| hero, store name/subtitle, OG title    | flat and declarative — one claim, no hedge, no supporting clause       | "Links encrypted on your device"                                                                                |
| /about, /faq, `FULL_DESCRIPTION`       | argued and long — makes the case, then concedes                        | "That is not a privacy policy. It is the architecture."                                                         |
| in-app labels and helper text          | instructional — what this does, in the user's own words                | "Every link you save shows up here, whichever list it lives in."                                                |
| empty states                           | names the next act, never the absence                                  | "No tags yet. Type a name to make one."                                                                         |
| upgrade and paywall copy               | names what stays **free** in the same breath as what does not          | "Nesting a list inside another is a Plus feature. Flat lists and tags stay free and fully usable."              |
| errors                                 | fixed shape, below                                                     | "Could not change your password. Please try again."                                                             |
| /terms, /privacy, the consent sentence | plain and literal — full document titles, no marketing register at all | "By creating an account, you agree to our Terms of Service and Privacy Policy" (`components/legal-consent.tsx`) |

#### what binds where

The rules in this file are of two kinds, and applying them evenly to every
surface goes wrong in both directions.

**Claims bind everywhere, in full, at any length.** What our servers hold, what
ships, the source boundary, no adjectives about intent, no "zero-knowledge"
(_terminology_, _only what ships_, _the source_). A reader tests a claim, not a
channel: a one-line reply, a blog post, and a personal post by someone who works
here are all read as our word about the product. A short surface may shorten how
a claim is put, never what it claims, and scope is never the thing to cut
(_states its own costs_, above).

**Form binds where we are the published voice, and relaxes with the channel.**
The mechanics, the generated-shapes list and the tone table exist so that pages a
reader meets together read as one author. A reply to one person has no sibling
page to match.

| surface                              | form                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| site, store listings, in-app strings | all of _the voice_ and _the mechanics_                                                                                                                                                                                                                                 |
| /docs and help pages                 | plain steps, the costs where the reader meets them; the generated-shapes list doesn't reach steps                                                                                                                                                                      |
| the blog                             | the argued register, so _what reads as generated_ applies, with the full costs                                                                                                                                                                                         |
| the product's X account              | the voice and the mechanics, including no jokes; a post is too short for every cost, so the one test in _states its own costs_ decides                                                                                                                                 |
| a team member's personal account     | their own voice, jokes included; a sentence about the product is held to the claims above, and a stance or a joke on its own is theirs                                                                                                                                 |
| replies, on X and by email           | write to the one person: answer what they asked, in their words, with the specific answer where they asked a specific question; contractions; plain apostrophes are fine; only the costs their question touches; no pasted template lines; nothing that hasn't shipped |

The last two rows are the loosest on purpose and the easiest to overdo. A reply
that is friendlier or looser than the pages is fine. A reply that says something
the pages don't, about what we hold or what a check proves, is a new claim, and
nobody reviews it before it is sent.

#### errors have a fixed shape, and it is already in the code

Two forms, and the choice between them is whether the user can do anything.

- **Nothing they can act on** — _"Could not ⟨their own verb⟩. Please try again."_
  "Could not sign in.", "Could not create account.", "Could not change your
  password.", "Could not generate a recovery code.", "Could not sign out your
  other devices." The subject is **us**. There is no "Error:", no status code, no
  "Something went wrong", and nothing cute — a product whose case is precision
  does not get to be playful at the one moment it failed.
- **Something they can act on** — name what was wrong, then the act.
  "That recovery code didn't work. Check it and try again." / "This doesn't look
  like a valid URL. Click Confirm to save it anyway." / "This link is in your
  Trash. Restore it, or click Confirm to save a new copy."

⚠ Every one of these **mounts**, which means every one of them needs
`role="alert"` and a carrier that provides it. That is not a wording rule and it
is the one with a worse failure mode: the text appears and nothing is announced.
[accessibility.md](./accessibility.md) owns it.

#### only what ships — and a tool's output is copy

**Promise only what ships.** The list of what is planned and not shipped lives in
one place, the copy rule at the top of `packages/shared/src/stores/listing-copy.ts`
— read it there rather than copying it here, where it would go stale. The rule
is older than this section and was written for store copy, which is why it sat
in that file alone. It binds every string a user reads.

**That includes what a tool prints.** The marketing site's bookmark converter
writes a receipt — losses, warnings, skipped-record reasons — and its own
errors, from `packages/shared/src/tools/bookmark-converter.ts` and the worker
beside its page. None of that looks like copy: it is built in a loop, from
counts, far from any page. It is still the product talking, it is held to this
whole section, and nothing checks it — `listing-copy.spec.ts` walks the store
strings only. The specimen: when Bracemark backups became a converter input, the
receipt's losses line and the page's input row both listed page copies and
screenshots among what a backup holds. Both were planned features then, and a
sentence saying they are "not included" told the reader they existed. (Screenshots
have since shipped, on desktop; page copies have not — the list is in
`listing-copy.ts`.)

**Another app's feature, in its own words, is not the same finding.** The
converter reads LinkWarden, whose exports carry archived pages, so "archived
pages" on the converter's page describes that data and stays. What is barred is
our name for our planned feature — "page copies", "screenshots" — which reads as
ours wherever it appears.

**Another tool's words about us become ours when we post them.** That paragraph's
converse: there, another app's words describe that app's data and stay. Here,
they describe us. A screenshot of an AI's read of this repo, a scanner's report,
or a reviewer's verdict, put on a page or in a post, is held to this whole
section and to _terminology_, because we chose to show it and where to crop it.
It is harder to keep than our own copy, for two reasons. The tool doesn't know
these rules: asked what the code sends off a device, it can answer "no
analytics", bare, which is the phrase _terminology_ bars because /privacy names
the totals we count on the server. And we can't edit its words, so the only
fixes are the crop, the text posted beside it, an answer ready for the reply it
invites, or not using it. Check it as copy before posting, including the parts
that flatter us: those are the ones a reader will test.

**A limit the copy states is a claim, and it has to hold for the ordinary
case.** The same change printed "up to 100,000 links" beside a byte limit that
stopped a note-free library at about 94,000; the fix moved the limit, not the
sentence. Where two limits interact, the copy names the one the reader will meet
and the condition under which they'll meet the other — "fewer if they carry long
notes". [data-lifecycle.md](./data-lifecycle.md), _the bookmark converter's
limits_, has the measurement.

#### what reads as generated

**A few sentence shapes read as machine-written whatever the claim inside them,**
and a property whose case rests on the reader believing its sentences can't
afford that. The list starts from the [`tells`](https://github.com/ArchAstro/tells)
study (MIT), which measured 75 essays from three models, all given one detailed
style brief, against 50 essays by one writer. That is one writer and one brief,
so a shape here is a reason to re-read the sentence and not proof of anything.
There is no score to pass, and the tool itself isn't used here: it models one
person's own writing, and this is a house voice.

**The scope is running prose on a surface that argues**: the _argued and long_
row of the table above, plus the blog. It doesn't reach the brand lines, the
flat hero register, a specimen quoted in this section, the steps in `/docs`, or
in-app strings and errors.

| shape              | looks like                                     | stays when                                                                                             |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| punchline fragment | "Every time." or "Not once." after a claim     | it answers a question, as the FAQ's "Yes." does; a fragment is never added for rhythm                  |
| reframe            | "This isn't a sync tool. It's a promise."      | the negated half is something the reader actually believes, so the sentence corrects a real conclusion |
| stacked commands   | "Skim it now, come back to it later."          | the reader is doing the task: a step, or a test they can run, such as "Turn off your connection"       |
| colon label        | "The fix: …" or "Cost: …" opening a sentence   | the sentence reads straight through its colon: "The complete backup is a zip: one JSON line per item"  |
| verbless opener    | "Pieces, state, invariants." opening a section | it is a bold lead-in on a list item, naming what the item says                                         |
| rhythmic three     | parallel triples, paragraph after paragraph    | the facts supply the count: the API really does three jobs in "sign-in, sync, and billing"             |

**The slogan is a reframe on purpose.** So is the tone table's "That is not a
privacy policy. It is the architecture." Both pass the test, because the negated
half is what a reader assumes of any company, and both are why the shape isn't
for spending elsewhere. A scan of the blog on 2026-11-02 found one other reframe
across six posts, so this row guards against a drift rather than cleaning one up.

**Shorten by removing an idea, not by compressing what is left.** A compressed
sentence keeps every idea and loses the small words that made it readable, which
is how "bytes we hold no key **for**" (_the voice_, above) and the heading behind
"a key derived from your password" (_terminology_, below) both shipped. A
character budget is where this happens, in a store field or a social post: drop
a clause's whole idea, and keep the "to", "so", and "because" in what remains.

**Fix the finding and nothing near it, then re-read the paragraph.** Rewrites
overcorrect: splitting a sentence to lose an "and" is how the first row of the
table gets written. In the same study, "almost no em dashes" produced none at
all, and "you more than I" produced almost no "I". A rewrite held to this page
does the same thing, so every rule here is a boundary and not a quota. A clean
review isn't evidence either: its authors tuned one draft until nothing was
flagged, and a detector still scored it 91% AI. A person reading the page is the
check, and nothing here replaces that.

#### the mechanics

Written down because they are already kept, not because they are being decided
here — the point is that the next string matches the last two hundred.

| rule                      | this                                                                                                      | not this                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| headings, buttons, labels | sentence case — "What it costs to build it this way", "Create account"                                    | Title Case                                                           |
| em dash                   | spaced — "…when you are done with it — it leaves My List but stays saved"                                 | unspaced, or a hyphen standing in                                    |
| exclamation marks         | none, on any user-facing surface                                                                          | one "!" anywhere                                                     |
| serial comma              | yes — "links, lists, tags, pins, files, and settings"                                                     | dropping it before the final "and"                                   |
| contractions              | the default — "won't be shown again", "doesn't look like a valid URL"                                     | uncontracted-by-habit, which reads legal                             |
| spelling                  | British, with **-ise** — behaviour, colour, organise, recognise, authorise, cancelled, licence (the noun) | American — behavior, color, organize, recognize, authorize, canceled |
| the platform verb         | **click** on web, **tap** on expo — the ported string differs in exactly this word                        | "select", "press", or one string serving both                        |
| plan names and numbers    | read `PLAN_LABELS` and `iap/plans`; store copy carries **no** numbers at all                              | typing "Plus", a price, a cap, or a trial length                     |

**A serial comma needs three items; two take none.** Count what the "and"
closes: three or more and the comma goes in ("links, lists, and tags"); two and
it stays out ("a path and a size", "reads every message and writes or approves
every reply"). A comma between two **clauses**, each with its own subject, is
ordinary punctuation and stays: "There is no grace period, and we don’t bring a
deleted account back from a backup." The one exception is an **ampersand
label** — "List, tags & note" — where the `&` already marks the last item.
Nothing enforces it: a missing comma has no selector, so this page is the check.
Headings in /terms and /privacy are quoted by name elsewhere on the same page, so
a heading and its cross-reference move together.

**The spelling is British, with -ise, not the Oxford -ize**, because that is what
the existing pages used. The scope is every string a user reads, and it reaches
the repository's own public prose — `SECURITY.md`, the root `README`, the reports
in `security-reviews/`, and the store notes in `release-notes/`. Four things stay
as they are, because they are names or data rather than our prose: **another
app's words** (Raindrop's _Favorites_, LinkWarden's _Unorganized_ collection, a
CSV column called `favorite`), **identifiers** (CSS `color`, schema.org's
`Organization`, an API field), **a platform's string quoted verbatim**, such as a
browser's permission warning, and **_dialog_ and _program_** in their computing
sense, which British usage spells that way too. Code comments and `docs/` are not
held to it. Nothing enforces it — each author spells the way they spell, and
nothing reads the page as a whole — so this page is the check.

**Contractions are the default, and "cannot" is a decision.** The tagline says
_can't_ and `FULL_DESCRIPTION` opens with _cannot_ — "Bracemark is a bookmark
manager that **cannot** read your bookmarks". The uncontracted form is the
heavier one, and the line falls in the same place for every author: **"cannot"
when the subject is us or our server and the verb is about reaching the
library** — read, open, decrypt, search, index, sign you in. "Of your library we
hold ciphertext we cannot open", "a server that cannot read your links cannot
search them for you either", "we cannot sign you in or decrypt your account for
you". Everything else contracts, including sentences about us: "we can’t offer
payment", "an edit you regret can’t be rolled back from our side" (a missing
feature, not the architecture), "Permanent deletion can’t be undone". **The brand
lines are the exception**, in the other direction: the tagline and the slogan
("We built it so we can’t") are spoken lines, set once in `brand/brand.ts`, and
keep their contraction although they state the claim. /terms, /privacy and
/security write out every negation on purpose; that register is theirs.

⚠ **The apostrophe is the typographic `’` in everything a user reads — an
editorial choice, not a consequence of the quote character.** `.prettierrc` sets
`singleQuote: true`, and prettier picks whichever quote needs fewer escapes, so a
straight `'` in prose silently flips its literal to double quotes and the next
sentence gets written to match; the same recovery-code sentence once existed in
both forms, one screen apart. Writing `’` dissolves the mechanism. Two things
hold it:

- **Two specs assert it** over every exported string in the published-copy
  modules: `listing-copy.spec.ts` for the store copy and `brand.spec.ts` for the
  brand lines, `COMPANY` and `SOURCE`. Each walks its module rather than a list of
  names, so a new export is covered.
- **`no-restricted-syntax` in the root `eslint.config.mjs`** holds it over every
  `.ts` and `.tsx` in the workspace, with three selectors: `Literal`,
  `TemplateElement` and `JSXText`.

Three things are worth keeping. **Write `’` in JSX text, not `&apos;` or
`&rsquo;`**: Babel decodes `&apos;` into the straight `'`, so it was only a
disguise a search for `'` can't find, and a bare `'` in JSX text passes lint
because `react/no-unescaped-entities` is not enabled here. **The rule is about
the character, not the reader**: a log line, a thrown `Error` and a dev warning
all take `’`, because making every author judge whether a string might reach a
user is the call that produced the drift. The one exception is where the
apostrophe is **data** — a parser token, a fixture, a value compared against user
input — where `’` would be a bug and a disable comment is right; there are none
today. Out of scope: **comments**, and **specs and `e2e/`**, where a test name is
prose nobody reads in the product. A spec asserting on real copy still has to
spell it exactly.

**The copy that exists twice lives in one file.** `packages/react/src/lib/` holds
it: `recovery-code-copy.ts`, `lock-copy.ts`, `misc-settings-copy.ts`,
`paywall-copy.ts`, beside the `new-password-copy.ts` that set the pattern. Each
covers a surface that exists once per platform, where the native half is a hand
port of the web one and nothing but the shared file keeps the two saying the same
words. What goes in: only the **words**, and only when there are two of them — a
string that exists on one platform only (the biometric button) stays at its call
site. `PAYWALL_COPY` marks the edge: each entry carries the `plan` that unlocks
it, which is not a word at rest but is one by the time it is read, since the CTA
renders `Upgrade to {PLAN_LABELS[plan]}` and the description names the same plan,
so the two travel together or the sentence can promise Plus while the button sells
Pro.

⚠ **The quotation mark is the typographic pair `“ ”` (U+201C/U+201D)**, by the
same editorial rule and with the same scope — every string, one pair, never a
straight `"`, never `&quot;` or `&ldquo;`. Nothing ever pulled it wrong (prettier
flips a literal only when it holds more single quotes than doubles), so it has
been right by taste, and it is written down at zero rather than after a drift.

- **Three jobs.** A delimiter around **content the user typed** (`Create “{trimmed}”`, `Move “{name}” to`); a **defined term** in the legal pages
  (`(“{COMPANY.shortName}”, “we”, “us”)`, the “Service”, “AS IS”); and a
  **mention**, where a phrase is discussed rather than asserted (_What does
  “end-to-end encrypted” actually mean here?_).
- **Nesting is barred.** The inner pair `‘ ’` closes with the same codepoint as
  the apostrophe, which would put an apostrophe at the end of a phrase one word
  from a real one. Restructure the sentence.
- **Quoting a UI label** depends on what the reader has to do. A **named surface
  or system list** stays bare — My List, Archive, Trash, Show All are data. An
  **option value inside a control** takes the quotes, because the reader has to
  find that exact string in a row of radios: _switch the setting from “Sync” to
  “Device”_.
- **What holds it is weaker than the apostrophe's guard, deliberately.** A fourth
  `no-restricted-syntax` selector covers `JSXText`, where a straight `"` is
  unambiguously prose, and the two spec walkers assert it. There is no `Literal`
  selector, because `"` is real data here (CSV quoting, HTML attributes,
  regexes). So a **prose string in a single-quoted literal** (`'the "Service"'`)
  is the gap, and this page covers it, most of all in the two long store
  descriptions in `listing-copy.ts`, which are pasted into a store console by
  hand.

#### terminology

The load-bearing pair — bookmark and link — has its own section below. The rest:

| use                                                                                                                                                       | not                                                                                                                         | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"a key your password unlocks"**                                                                                                                         | "a key derived from your password"                                                                                          | the root of an account is a **random DEK**; the password derives only the KEK that unwraps a copy of it, which is how a recovery code opens the same library — so "derived" refutes itself one clause later ([account.md](./account.md), the callout under _the model_). Two nearby spellings are right and must not be "corrected": the wrapped blobs are "locked with a key derived from your password or recovery code" (that IS the KEK), and "your password is put through Argon2id to derive a key, and that key unlocks the one your library is encrypted with"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **"each link is encrypted"**, "my links", "your library"                                                                                                  | "everything is encrypted", "your data is encrypted", "encrypts your data"                                                   | the LIBRARY is what is encrypted — every link, list, tag, and setting is its own encrypted file — and the account is not: the username, the public key, the session records, and the subscription row are held in the clear, and each encrypted file keeps a readable path, size, and timestamp ([local-first-sync.md](./local-first-sync.md), _crypto boundary & what the server still learns_). "Everything" is a true subset presented as the whole, and it arrives as a **premise, not an assertion**: the "if" or "so" clause of a sentence about something else, or a question in the reader's voice, is still our copy. "Your data" is the same quantifier without the word; the username is the reader's data too. The fix keeps the sentence's length: name the object ("each link", "my links") or the mass noun ("your library"). Right, and not to be "corrected": "Everything your library is encrypted with comes from that one key" and "Every link, list, tag, and setting is its own encrypted file" are scoped to the library; "Delete all your data" and "Export your data" state the reach of an action, not of the encryption                                                                                                                                                                                                                                                                                                                           |
| **"`api.bracemark.com` never sees your library in plaintext"**                                                                                            | "the server sees nothing", "only ever sees ciphertext", "the sync server"                                                   | one Worker serves auth, sync AND billing, so the same host that cannot read a link holds your username, public key, sessions and subscription row in the clear; only the LIBRARY is ciphertext-only, and there is no separate sync server to narrow the claim onto. An **enumeration that closes** ("nothing else on file") is the same error one step quieter, and a claim about what we SEE rather than what we HOLD is false the moment `bracemark-extractor` is on. `R2` only ever sees ciphertext IS true, and so is "blind sync broker" ([local-first-sync.md](./local-first-sync.md), _the shape of the problem_)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **"end-to-end encrypted"**, and then name what the server holds                                                                                           | "zero-knowledge", "we know nothing", "knowledge-minimized"                                                                  | there is no zero-knowledge **proof** anywhere in this stack, so the term is wrong in its own field — and on a property whose argument is that you can read the source, it is the most checkable false claim available. On the looser marketing reading it is false three ways over: the identity/billing plane holds your username, public key, sessions and subscription row; `bracemark-extractor` is handed a plaintext URL whenever the opt-in is on ([link-extraction-server.md](./link-extraction-server.md)); and R2 accrues object counts, sizes and timestamps. **"Knowledge-minimized" is not the fix**: it is accurate, and it is a claim about our intent, which _the voice_ bars beside "privacy-focused" wherever a mechanism is available — and four are: "end-to-end encrypted", "`api.bracemark.com` never sees your library in plaintext", "`R2` only ever sees ciphertext", "blind sync broker". `KEYWORDS` in `listing-copy.ts` keeps `zero,knowledge` and is outside this rule: a comma-list of search terms is not prose, and matching a query is not making a claim                                                                                                                                                                                                                                                                                                                                                                                   |
| **"no analytics code"**, "no analytics in the app"                                                                                                        | "no analytics", "we run no analytics"                                                                                       | we count totals on the server — accounts, recent sign-ins and syncs, subscriptions, and library sizes in ranges — from records already kept to run the service, and /privacy names those records under _How we use what we collect_. That is analytics by any reader's definition and by Apple's App Privacy one ("measure audience size"), so a bare "no analytics" is true of the code we ship and false of what we do. Scope the No to the code: "no analytics code" on the landing page and in the browser extension's listing, "no analytics in the app" in the mobile listing, "We ship no analytics or advertising code" in the FAQ, which then names the counting in its next sentence. /privacy's own No is "counting adds no analytics or tracking code"; it said "no analytics **product**" for a stretch, which our hosts' dashboards made arguable. Beside the request logs our hosts keep, /privacy states the uses rather than limiting them (finding a fault or an attack, and the totals their consoles compile), because those consoles build traffic reports whether we open them or not; "we read it only to diagnose a fault or an attack" was a purpose limit on a dashboard we do not control. The store declarations must carry the Analytics purpose to match, or the listing and the label disagree on one screen                                                                                                                                  |
| **our API**, glossed once per page                                                                                                                        | "the sync service", "the account service"                                                                                   | `bracemark-api` is one Worker behind sign-in, sync, and billing, and a name taken from one of those jobs is the `api.bracemark.com` row above arriving as a noun: the help page on encryption called it "the account service" where it listed what we hold and "our sync service" three paragraphs earlier. The gloss is /privacy's, "the service behind sign-in, sync, and billing", and it goes on the first mention of any page a non-technical reader lands on. **"Our servers"** stays the collective for a claim about what we HOLD ("our servers hold a path, a size…") — plural, since the files sit in storage and not in the API — and "the server" stays in sync status strings, where it is the thing a device could not reach. Not to be confused with /about's "there is no public API", which is about an interface for other people's code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **link-extraction service**                                                                                                                               | "link-preview service", "preview service", "extraction service" on its own, "the preview server", "read-mode service"       | one service, one name, at one length. It was "link-preview service" until 12 November 2026, when the same service was also returning read-mode copies and the name no longer covered what it does. A second name for that half ("read-mode service") would claim a second service with rules of its own, where /privacy describes one. "Link-extraction" also meets the name a site operator sees — `bracemark-extractor`, on /extractor and in the user agent — so the policy's "its own page" link lands on the word it promised. The full form goes everywhere the service is named (/privacy, /terms, the FAQ, the help pages, the in-app prompt, both switches and the reader), because a short form beside the long one is how four names happened before. **"Server previews"** and **"Server read mode"** are SETTINGS, not the service, and "no server of ours" is a description, not a name; all stay. `bracemark-extractor` is the name on /extractor alone, read by people who found it in their access logs. The published security-review post keeps "the preview service": it reports what was examined under that name, on its date                                                                                                                                                                                                                                                                                                                          |
| **browser extension** / **share extension**                                                                                                               | "extension", bare                                                                                                           | two unrelated things carry the name; a store listing is read by people who know neither exists ([architecture.md](./architecture.md#apps))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **password**                                                                                                                                              | "passphrase", in any user-facing copy                                                                                       | the app never prints the other word: `NEW_PASSWORD_COPY` (`react/lib/new-password-copy.ts`) says _password_ for the generated words too ("Generated for you." under the field, then "Save it in a password manager…"), so a surface that says _passphrase_ names a thing the reader will not find in the ceremony. It is the engineering name for the generated default (`crypto/passphrase.ts`) and stays in docs, identifiers and comments — it had leaked into the landing page, the FAQ and the store listing before this row said so ([account.md](./account.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **recovery code**                                                                                                                                         | "backup code", "recovery key"                                                                                               | one name, and it is the one the crypto uses (`crypto/recovery-code.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **sign in / sign out / create account**                                                                                                                   | "log in", "login", "sign up"                                                                                                | already unanimous across both apps; "login" is a noun and never a verb                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **My List, Archive, Trash, Show All**                                                                                                                     | "inbox", "bin", "all items"                                                                                                 | these are data (`sync/system-lists.ts`), not copy — never retyped, never translated in prose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Free, Plus, Pro**                                                                                                                                       | "premium", "paid tier"                                                                                                      | `PLAN_LABELS` is the source; see the mechanics table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **list, tag, pin**                                                                                                                                        | "folder", "label", "favourite"                                                                                              | the UI names places and the schema agrees; a synonym in prose teaches a second vocabulary for one feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **copies** — one is a **read-mode copy**, a **screenshot** or a **page copy**; together, "the copies you keep"                                            | "kept copies" as a label, "page copies" for the three together, "link copies", "archived pages", "snapshots", "saved pages" | what is kept is the PAGE, not the link — "link copies" reads as duplicate bookmarks, beside a menu whose "Copy link" copies the address. A **link preview** is not a copy and stays outside the word: it is a title and an image fetched for every link so the list reads, where a copy is the page itself, kept for when it moves, changes or goes behind a sign-in. _Page copy_ names ONE kind (planned — _only what ships_ above keeps it out of public copy until it lands), so the umbrella is the bare noun and never "page copies". The neighbours each fail on a word already taken: "archive" is the Archive system list's, "snapshot" blurs into screenshot, "saved pages" into saving a link, and "offline copies" claims an availability nothing guarantees. "Kept copies" is the docs' and the code's name for the three (`keptCopies`) and stays there. A heading or a control names the KIND (Settings → _Read mode_, "Keep a read-mode copy", "Keep a screenshot when you save"); the umbrella is for where more than one kind is meant — the paywall, the storage note, bulk edit — and works best as a verb: "Keep a copy". The verb that undoes one is **delete**: "remove" in this app moves a link to Trash, and on a copy it would promise a recovery that does not exist                                                                                                                                                                              |
| **read mode** as a noun, **read-mode** only before one — "in read mode", Settings → _Read mode_, "a read-mode copy", "Include images in read-mode copies" | "a read-mode" as a noun, "Read Mode", "Keep read mode on save", "Keep images in read mode"                                  | the ordinary compound-modifier rule: the hyphen when the two words together describe a following noun, open everywhere else, so the hyphen marks exactly one job, the copy's kind. It matters more than usual because **"mode" names a way of viewing** (every browser has a reader mode): bare read mode as the object of a verb reads as a display setting, and "Keep read mode on save" parsed as "keep read mode ON". Where the words are about the THING kept, the noun is **copy** and read-mode qualifies it ("Keep a read-mode copy when you save", "Include images in read-mode copies"). Bare read mode stays right where nothing can be mistaken for a mode: "its text in read mode", "an article to keep in read mode". **A name keeps its own spelling**, even before a noun: "the Read mode section", like "the Link previews section", and a setting's name too (_Server read mode_, beside _Server previews_). The per-link button is _Keep a read-mode copy_ (the web reader); on expo's capture screen it is _Keep a copy_, because it shares a row with _Update preview_ at half a phone's width, and a read-mode copy is the only kind the phone takes. The browser extension's saved screen names the bare kind, "Read mode" and "Screenshot", under a _Keep a copy_ heading. Not "auto" ("Auto-make a read-mode copy"): a switch whose title ends "when you save" is already automatic. Docs and comments follow the same spelling; code is `readMode` |
| **the successor to Brace.to**                                                                                                                             | "the second version", "v2"                                                                                                  | the predecessor was renamed AND rebuilt — a decentralised identity stack traded for our own end-to-end encryption — so "second version" names an increment that did not happen, and /about contradicts it two sentences later ("named after a domain nobody could say out loud"). "Successor" is what the repo already calls it everywhere but its public surfaces (`data-lifecycle.md`, `brand/brand.ts`). Not "next generation" either: that fails _mechanical_ above — a reassuring adjective with no content, pointing forward where the claim is a backward-looking track record. It is stated on exactly TWO surfaces, the landing page's _If we disappear_ footnote and /about's _Where it came from_, and they have to agree. Both carry the YEAR and the LINK, from `PREDECESSOR` in `brand/brand.ts`: an unlinked, undated product name is a track record a reader cannot check. Both also say **and still run today**: a predecessor named only in the past tense reads as churn on the very band arguing we will still be here. That clause reports what is running; if the domain ever stops answering, the link comes out of both surfaces and the tense around it is re-read in the same change                                                                                                                                                                                                                                                               |

And the collection still gets no noun — "vault" and "library" are ruled on in the
next section, which is where the whole terminology argument is made at length.

### the two nouns — bookmark and link

The product has **two words for the thing it stores, and they are not
interchangeable.** Both are correct; each is the best word for a different job,
and using either everywhere breaks something specific.

| word         | job                                                                                    | where it belongs                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bookmark** | the **category** — what kind of product this is, and what it is being compared against | the three brand lines above; `FULL_DESCRIPTION`'s opener; the marketing site's meta description, `/about` and the comparison FAQs; **file formats** (`import/netscape.ts`, `export/netscape.ts`, the "HTML bookmarks" import label) |
| **link**     | the **object** — the thing a user saves, opens, files and acts on                      | every in-app surface: "Add link", "Edit link", "Copy links", "Search links…", "No links saved yet", "Unlimited saved links"; the `/links` route; `LinkQuery`; the `links/` blob namespace                                           |

The marketing site's footer runs both in one breath, and is the pattern in
miniature: _"An end-to-end encrypted bookmark manager. Your links are encrypted
on your device…"_ — category, then object.

**Three reasons the split is load-bearing rather than habitual.**

- **"Bookmark" is the searched word.** Nobody types "link manager". The name
  alone does not say what the product does, so the outward lines have to carry
  the category — and it is the category term the stores index.
- **"Bookmark" is already taken, by the browser.** The sharp one. This app
  _imports_ browser bookmarks, so if our objects were bookmarks too, the import
  copy would read "import an HTML bookmarks file … bookmarks you already have are
  skipped" — theirs or ours? It reads "**links** you already have are skipped",
  and is unambiguous. The same collision is handled deliberately in
  `apps/bracemark-extension/wxt.config.ts`, where declaring Firefox's
  `bookmarksInfo` is rejected because it would tell users we read their bookmark
  _tree_. On that surface the word means the browser's tree; it cannot also mean
  ours.
- **"Link" is what the URL and the schema already say** — `/links`,
  `links/{id}.enc`, `LinkQuery`. An in-app noun matching the path in the address
  bar is consistency for free.

**The collection gets no noun at all — and "vault" and "library" are why that is
a rule.** The UI names **places** (My List, Archive, Trash, Show All); a user
files into a list and never addresses the whole, so there is no slot a container
word could fill. "Vault" is additionally barred by the paragraph above it: it is
a claim about how the product _feels_, in a product whose argument is that
feelings count for nothing beside mechanism. It appears once in the codebase, in
`KEYWORDS` in `listing-copy.ts` — which is a comma-list of search terms, not
prose, and outside this rule. "Library" is serviceable as a **mass noun in
prose** ("bring the library you already have", "someone with a large library")
and is not a label; promoting it to one is the same mistake as "vault".

**A disclosure is named for what is behind it, not for how hard it is.** The
quick-add form's second section reads **"List, tags & note"** — it was "Advanced",
which claimed a novice/expert axis the form does not have (filing a link into a
list is the most ordinary act here; URL is simply the required field and those
three are the optional ones). The word is right one screen over, on advanced
**search**, where a plain text box really does sit opposite the full query grammar.
Two constraints on any replacement: **"More options" is taken** — it is the topbar
overflow button's name in both clients — and **"Details" is spoken for**, by the
link detail view `/links/{id}` is reserved for. Naming the contents also follows
the rule above it: the concrete names beat a container word.
[editors.md](./editors.md) carries the rest.

⚠ **Nothing enforces any of this** — a `<Button>Add bookmark</Button>` type-checks
and lints clean. The check is this page. Related: the first-sync counter says
**"items"**, a third word for a third scope (`sync/status.ts` carries the
reasoning — it counts index blobs across six namespaces, not links), which is the
same instinct one level down and not an exception to the table.

### the source — what we may claim

**The repository is public: `github.com/stxapps/bracemark-monorepo`, AGPL-3.0.**
The whole product is in it — both apps, the browser extension, both Workers, the
marketing site. The one public surface outside it is the status page
(`status.bracemark.com`), in `github.com/stxapps/bracemark-status` under the same
licence, kept apart so it does not go down with what it reports on
([hosting.md](./hosting.md), _the status page_). This is a **claim we make about ourselves**, so it is subject to
the same rule as the brand lines: it must say the same thing on every surface,
and it must not outrun what the code supports.

**The claim boundary, which every surface below is written to.** Public source
lets a visitor **read what we do**. It does **not** let them verify that the
bundle their browser executed was built from it — there is no reproducible build
and no signed release, so nothing ties a served asset back to a commit. So:
_"see for yourself what we do"_, never _"verify what you are running"_. If
reproducible builds ever ship, this paragraph is what changes, and the surfaces
below move with it. What they would and would not prove, per platform, and what
the new boundary may say: [reproducible-builds.md](./reproducible-builds.md).

**What we claim, and what we don't.** We claim that the source is public under
the AGPL, that a reader can read what the code does, and that a network inspector
shows what the running build sends. We don't claim that any of the three proves
another, that the build a reader runs came from the repo, or what a key does with
what it holds. None of them is a guarantee, and every one is better than taking
an app's word for it, which is the point of offering them.

**The bar is on the object, not the word.** What is barred is a claim that a
check reaches a result about the build a reader is running: "verify what you are
running", "verifiable", "transparent". The verbs are not the problem. "Read",
"check", "watch" and "see for yourself" describe what the reader does and are the
default. "Verify" is allowed where it is the reader's own act and a limit has
already been said, which is how the proverb "trust, but verify" reads straight
after "none of these checks is a guarantee". It is not allowed as our claim about
a build.

**The limit scales with the room, as the costs do** (_the voice_). Every surface
states a limit rather than leaving a reader to discover it. How much it says
depends on what the surface claims and how much room it has.

| surface                                                                                                | the limit it carries                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| the pages that make the argument: /about, /faq `source`, /security, the repo README, a blog post on it | the build gap in full: no reproducible build, no signed release, nothing ties a served asset back to a commit                                        |
| a short surface that points at a check: a post, a caption, a store field                               | one broad clause that no check is a guarantee. It claims nothing, so it needn't name the gap                                                         |
| a reply to someone asking about the build, anywhere                                                    | the specific answer, because that is the question: the source is public, the build isn't reproducible, so a reader can't confirm theirs came from it |
| any surface that tells a reader to use an AI                                                           | the broad clause covers it where room is short; with room, add that an AI can be wrong and the reader should open the lines it cites                 |

What no surface may do, at any length, is imply that one check proves what a
reader is running.

**A network inspector is a third thing, and it sits inside the boundary.** Both
halves above are about the SOURCE — what a reader can read, and what reading
cannot settle. A browser's own network inspector is neither: it observes the
behaviour of the build that is actually running, which is precisely what the
source cannot speak to. So it is admissible, and /security carries it once
(_what this page does not prove_), as an OBSERVATION rather than a check that
anything matches anything. Three limits travel with any sentence that **states
what the inspector will show**, and that sentence has to hold all three at once.
A surface that only **points** at it — telling a reader they can open it and
look, with no claim about what they will find — states no result and needs only
the broad limit above:

- **It shows what a request contained, not what a key is doing.** Opaque request
  bodies are equally consistent with a key that never leaves and with one
  exfiltrated in a field nobody looked at. Nothing stronger than "you can watch
  your links leave as bytes nobody at our end can read" survives, which is why
  the words _verifiable_ and _transparent_ stay out of it — they are the
  vocabulary this boundary exists to refuse.
- ⚠ **Scope it to the library payload.** The same tab shows the username at
  sign-up, a session token and the R2 host, all readable and all inventoried in
  /privacy — plus the plaintext URL handed to `bracemark-extractor` by anyone who
  turned the `serverExtraction` opt-in on
  ([link-extraction-server.md](./link-extraction-server.md)). "Nothing
  readable leaves" is therefore false, and falsifiable in the one place we just
  sent the reader to look, which is the worst available way to lose the argument
  this page is making.
- **Name no tool and no request.** "Your browser's network inspector", never
  Chrome's DevTools: naming a vendor dates the copy and reads Chrome-first for a
  product with four clients. No endpoint, method or request shape either — those
  rot exactly the way a published cap does. That is about published copy, which
  dates. In a one-to-one reply, naming the tool the person is using is just
  helping them.

**Why AGPL and not MIT.** A hosted fork is the only real competitive risk, and
the AGPL's network clause is the one that addresses it: run a modified version as
a service, publish the modifications. It does not restrict a user, which is the
audience that matters here.

⚠ **The licence is stated in three places and they have disagreed once already.**
The root `LICENSE` file (AGPL-3.0), the root `package.json` `license` field, and
`SOURCE.license` in `packages/shared/src/brand/brand.ts`.
`package.json` said `MIT` against an AGPL `LICENSE` for the repo's whole first
stretch, which is not cosmetic: a reader may rely on either, and the permissive
one is the one they would rely on. `brand.spec.ts` pins the third copy;
the other two are on you.

**Where it is published, and why each.** The URL and licence come from `SOURCE`
in `brand/brand.ts`, beside `COMPANY`, for the same reason `COMPANY` is there.

| surface                             | what it says                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| marketing site footer, _Company_    | "Source code" — where a developer looks first, on every page |
| the landing page, _If we disappear_ | the repo linked inside the durability argument (below)       |
| /about, _See for yourself_          | the argument and the caveat, in prose, after "Who makes it"  |
| /about, the _Built with_ colophon   | `AGPL-3.0 · github.com/…` as a specimen line                 |
| /faq, privacy group, `source`       | the question as actually asked, before `security-report`     |
| /faq, privacy group, `self-hosting` | what it would actually take, at the end of the group         |
| /privacy, _Security_                | so the policy's claims can be read against the software      |
| Settings → About, both apps         | one row; the only one not pointing at the marketing site     |
| the repo's `README` and `SECURITY`  | the landing surface, and where to send a vulnerability       |

Deliberately **not** on the home page **hero**, and not in the store listings. In
a hero it reads as a developer-audience signal competing with the actual pitch; in
store copy it is a claim that can only be corrected by shipping a build through
review.

The landing page's _If we disappear_ band is the one place on that page it does
belong, and the distinction is the argument around it rather than the page it is
on. The band answers "why should I believe you will still be here", which the
repo is a real part of the answer to — the code outliving the company is a
property, not a promise — and it sits two thirds down, in the argued register,
where a reader has already been given the pitch. Note what the band does **not**
do: it makes no claim about verifying a served bundle, so the boundary above is
untouched. Its durability sentence, "The library does not need us to be
reachable in order to open", is only as true as [sessions.md](./sessions.md)
(nothing wipes) and [offline-mode.md](./offline-mode.md) (something can still
open it) make it. Its link also **carries the prose** — "a single GitHub repository",
not the bare URL beside it — because the two surfaces whose job is to print the
string rather than link it are the footer and /about's colophon, and setting a
40-character URL inside an argued paragraph spends a clause on it.

**The self-hoster is answered in two places, and the split is the point.** They
are the only audience that reads an AGPL notice and asks the obvious next
question, and the silence that used to meet them read as an oversight rather than
a position. The landing band carries the POSITION, in one clause — "we do not
support self-hosting today, but the code does not stop existing when a company
does" — and /faq `self-hosting` carries what it would actually take. The band used
to carry a reason too ("the apps we ship have our server's address compiled into
them"), and that is what moved: ⚠ **naming one obstacle reads as naming the only
one**, and it invites "then make it configurable" — a settings field would leave
both larger obstacles standing, since `bracemark-api` is a Worker wired to
Cloudflare's own D1 and R2, and the mobile and extension builds reach a user
through stores only we can publish to. A true subset presented as the whole is
the same failure the privacy claims were rewritten to avoid
([local-first-sync.md](./local-first-sync.md), _the shape of the problem_), so the FAQ answer names all three and the band names none. What the
FAQ answer must NOT become: a how-to (a half-followed attempt is a support thread
we have just declined to take), or a roadmap entry — "today" describes where
things stand, and this band makes no promises about our future.

### the X account — @bracemarkapp

**The handle is `@bracemarkapp`, and it is not the product name.** `@bracemark`
was already held by someone else when the account was registered, so the name
"Bracemark" appears only in the **display** name, which X owns and this repo
cannot pin. Everything below follows from that gap: no surface retypes the
handle, because a surface that retypes it is a surface that can be wrong about
which account belongs to us.

`SOCIAL` in [`packages/shared/src/brand/brand.ts`](../packages/shared/src/brand/brand.ts)
is the one definition — `handle` (the `@` form) and `url` — beside `COMPANY` and
`SOURCE`, for the reason those are there: more than one origin names it, and
bracemark-web cannot read the marketing site's config.

| surface                           | what it does                                                       |
| --------------------------------- | ------------------------------------------------------------------ |
| `twitter.site`, both root layouts | publishes the handle on every card that unfurls from either origin |
| marketing site footer, _Company_  | the handle as its own label, beside "Source code"                  |
| Settings → About, both apps       | the last row, after "Source code"; the handle as its title         |

⚠ **The failure is a handle that is WRONG, not one that is missing.** Both
layouts left `twitter.site` deliberately unset for the repo's whole first public
stretch, and the comment explaining why named the reason: the value it used to
hold was `@bracedotto`, **Brace.to's** handle, carried over from the predecessor.
A card carrying a stale `@` renders exactly as well as a correct one — no error,
no lint rule, no failing test — while crediting someone else's account to every
person who shares a page. `brand.spec.ts` pins the two halves against each other
(the URL must be the handle, and the handle must keep its `@`, which is what the
meta tag is specified to carry); it cannot pin that either one names an account
we still control.

**Why the footer link is labelled `@bracemarkapp` and not "X".** The letter alone
names nothing when read cold, and — per the paragraph above — the handle is not
derivable from the product name, so a visitor who intends to search for us rather
than click has to be able to read the string we actually hold. It is also the
only link on the marketing site pointing at a property we do not control, which
is why it sits under _Company_ with "Source code" (a fact about who builds this)
rather than under _Product_.

**In Settings → About it is the LAST row, under "Pages", after "Source code"**,
in both apps. Those two are the only rows in that group not pointing at the
marketing site, and they end the list in the footer's order for the footer's
reason: one is a fact about who builds this, the other is the only link on the
surface to a property we do not control. The row is titled with the handle and
described as _"Announcements and release notes, on X."_ — the description is
where "X" is allowed to appear, because by then the reader has the string. It
stops at announcements deliberately, two rows under "Support": see below.

**Not on `/support`.** That page opens _"One address, and a person on the other
end. No ticket queue, no chatbot, no phone tree."_ — a second channel on it makes
that line false, and a public reply is the wrong shape for a product whose
support questions carry usernames. Support is email; the account is for
announcements.
