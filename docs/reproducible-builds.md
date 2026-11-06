## reproducible builds

Whether anyone outside can check that what we serve was built from the public
source, which platforms that is worth doing on, what has to change in the build
to get there, and what we may say once it ships. Today the answer is "nobody
can", and every public surface says so.

Neighbours: [brand-assets.md](./brand-assets.md) (_the source — what we may
claim_: the claim boundary this doc would move, and the surfaces that carry it),
[hosting.md](./hosting.md) (_deploying the static sites_, _which commit is live_
and `/deploy.json`, _which build is in a store_), [offline-mode.md](./offline-mode.md)
(_which build is this page_: the `BUILD_ID` the update pill depends on),
[env-files.md](./env-files.md) (which env files are committed, so which inputs a
stranger has), [browser-extension.md](./browser-extension.md) (_releasing to the
stores_), [expo-build.md](./expo-build.md) (why the store apps are a different
problem).

> **STATUS — not built, and not promised.** One measurement exists: bracemark-web
> built twice for production **on one machine** with `BUILD_ID` fixed. All 217
> files came out, every JS chunk matched, and 16 files differed: 15 HTML files
> carrying Next's own random build ID, plus `sw.js`, most likely because its
> precache revisions hash those HTML files. Nothing has been compared across
> machines, nothing has been compared against the live site, and the browser
> extension has not been tried. `/security` says "We are not promising either one
> is coming", so ⚠ **nothing public changes until this ships**
> ([the claim](#the-claim--what-changes-when-it-ships)).

### what it proves, and what it doesn't

Three separate questions. Public source answers the first; reproducible builds
add the second; nothing here answers the third.

| question                                                   | today              | with reproducible builds          |
| ---------------------------------------------------------- | ------------------ | --------------------------------- |
| What does the code do?                                     | anyone can read it | same                              |
| Is what the host serves **now** built from commit X?       | nobody can check   | **anyone** can check, at any time |
| Was what **my browser** ran on a given load built from it? | nobody can check   | still nobody can check            |

Seen as threats, the second row is where the value is. Without it, a bad build
served to **everyone** cannot be detected from outside. That covers a
compromised deploy machine, a build step that injects code the repo does not
contain, an untracked file that leaked into a build, or a change someone was
made to ship. With it, **one** person running **one** command catches any of
those, and the deploy history makes it hard to do quietly for long.

What is left is a **targeted** attack: a different bundle served to one user, or
for one request. For a web app that is the server's ordinary power, since it
sends the code on every load that the worker doesn't answer, and
reproducible builds do nothing about it. It is a much smaller threat than the
one removed. It takes control of the serving path rather than just the build,
it is aimed rather than broadcast, and any user who happens to compare catches
it.

Also **not** covered:

- **A malicious dependency in `package-lock.json`.** It is in the source, so the
  build reproduces it faithfully. Reading the lockfile is the defence, not
  rebuilding.
- **The Workers** (bracemark-api, bracemark-extractor). Cloudflare does not
  expose a deployed script to the public, so there is nothing to compare
  against. The encryption design keeps the server out of what the claim is
  about, with one exception: `bracemark-extractor` receives plaintext URLs from
  anyone who turned `serverExtraction` on
  ([link-extraction.md](./link-extraction.md)). That exception stays a
  read-the-source claim.

### per platform — what it is worth, what it costs

| app                     | worth          | why                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **bracemark-extension** | **highest**    | The store serves one versioned package to everyone, so the per-user gap mostly closes. A staged rollout serves two versions at once, which is still two known packages. Compare after unpacking, minus the store's signature files: Chrome adds `_metadata/`, Firefox adds `META-INF/`. Firefox Add-ons already asks for source and build steps when a package is bundled; check what that review covers before relying on it. |
| **bracemark-web**       | **high**       | The web app is where key derivation and encryption run for most users, and "the server can serve different JS" is the standard objection to an encrypted web app. Most of the work is done ([below](#bracemark-web--the-build-id-is-the-only-blocker)).                                                                                                                                                                        |
| bracemark-site          | low, but cheap | The marketing site holds no keys and runs no crypto. It is the same Next static export, so once the web app reproduces it may come for free. Do it only if it does.                                                                                                                                                                                                                                                            |
| bracemark-expo, Android | low, costly    | Play App Signing re-signs the app, and Play builds per-device split APKs from the bundle, so the comparison is unzip-and-strip-signatures per split. The Hermes bytecode has to be deterministic too. Possible, not cheap.                                                                                                                                                                                                     |
| bracemark-expo, iOS     | not practical  | App Store binaries are encrypted per device, so a user has no bytes to compare without decrypting a jailbroken device's copy. Say so rather than leave it out.                                                                                                                                                                                                                                                                 |

So the claim, when it exists, is **per platform** and names the ones it does not
cover. "Our builds are reproducible", unqualified, would be false the first
time someone asked about the iPhone app.

### bracemark-web — the build id is the only blocker

The measurement above says the JS is already deterministic. Two strings are
not: Next's own build ID, which is random per `next build` and written into every
HTML file, and our `BUILD_ID`, which `next.config.js` mints from the build's
start time and which ends up in every document (`<html data-build>`) and in
`/build.json`. `sw.js` follows from those, since its precache revisions
cover the HTML.

⚠ **Do not pin `BUILD_ID` to the commit.** It looks like the obvious fix, and
[hosting.md](./hosting.md#which-commit-is-live--deploy-tags) already rejected it.
`BUILD_ID` is what the update pill compares
([offline-mode.md](./offline-mode.md#which-build-is-this-page--one-stamp-two-places)).
A new value on every commit means a new worker and an "updated, reload" pill on
every deploy, including one that changed nothing in the app, such as a
docs-only commit. Nothing fails. Users just get told to reload for nothing, on
every release. The same goes for any id derived from the commit.

**The recommended approach: keep the id as it is, and let the verifier supply
it.** `BUILD_ID` is a label, not code. The live site already publishes it, at
`/build.json`. So the rebuild reads the live value and builds with it:

```bash
BUILD_ID="$(curl -s https://app.bracemark.com/build.json | jq -r .id)" \
  npx nx build @stxapps/bracemark-web --skip-nx-cache
```

Then the two random strings become one supplied one:

- **Next's build ID follows `BUILD_ID`**, through `generateBuildId` in
  `next.config.js`. That is the single code change. It leaves the pill's
  behaviour exactly as it is, because the pill never read Next's id.
- **`--skip-nx-cache` is required.** `BUILD_ID` is not an Nx input, so a cached
  build would replay whatever id it was built with. That is correct for
  deploys and wrong for a verification.
- A supplied label is not a hole in the proof. It is inlined as a string into
  an attribute and a JSON field, and every byte of code around it is still
  compared.

Read [offline-mode.md](./offline-mode.md) before touching `next.config.js` either
way. The `??=` there is load-bearing (static generation runs in worker
processes that must see the main process's id), and `generateBuildId` has to
return that same value.

### what a stranger needs to rebuild

- **The commit.** `/deploy.json` names it (`commit`, `dirty`). It is
  self-reported, which is fine here: the comparison is what checks it. A
  `dirty: true` deploy cannot be reproduced by anyone, by definition, and
  production refuses one without `--allow-dirty`.
- **The lockfile**, which is committed, and `npm ci`, not `npm install`.
- **The env files.** bracemark-web's `.env.production` and `.env.staging` are
  committed, and so are the browser extension's ([env-files.md](./env-files.md)).
  A gitignored `.env*.local` present on the deploy machine is also loaded by
  Next and WXT. The dirty-tree check cannot see it
  ([hosting.md](./hosting.md#which-commit-is-live--deploy-tags): "ignored files
  are outside the check"). A reproducible-build check **does** catch it, because
  the stranger's build lacks it and differs. That is a side benefit worth
  having on its own.
- **A Node version.** Nothing pins one today: no `.nvmrc`, no `engines`. Whether
  a different Node or npm changes the output is unmeasured. Pin one before
  claiming anything, and name it in the verification instructions.
- **An OS.** Unmeasured too. The deploys run on macOS, and a verifier is as
  likely to be on Linux. Absolute paths, file-ordering and line endings are the
  usual suspects.

### comparing against the live site

- **Walk the rebuild and fetch each file from the live host, not the reverse.**
  The bucket keeps old `_next/` chunks on purpose, because old tabs need them
  ([hosting.md](./hosting.md), _deploying the static sites_). Live has more
  files than any one build, and that is not a mismatch.
- **Exclude `deploy.json`**, which the deploy script writes and no build
  produces.
- **Map each file to the URL a browser would use.** The clean-URL CloudFront
  function (`tools/cloudfront/rewrite-url.js`) rewrites `/support` to the key
  `support.html` and canonicalizes with a 301, so a `.html` path may redirect
  rather than return the file. Also request no compression, or decompress
  before comparing.
- **Compare against the matching tier.** Each tier is built separately, with its
  origins inlined, so a staging rebuild never matches production.
- **Report per file**, with a diff for the ones that differ. "16 files differ"
  is useless to a stranger. "These 15 HTML files differ only in the build ID"
  is something they can judge for themselves.

### keeping it true

Determinism regresses **silently**. A dependency bump, a new plugin or a
`Date.now()` in a build script breaks it, and no lint rule, type error or test
notices. A one-off measurement is worth nothing a month later. So:

- **Run the comparison after every production deploy**, where the deploy
  script already re-checks the service worker after the invalidation. A
  mismatch there means the claim just became false, and the person who caused
  it finds out at once instead of a stranger finding out later.
- **Run it once on a second machine** (other OS, the pinned Node) before
  claiming anything, and again on each Node, Next, Vite or WXT major
  ([dependency-upgrades.md](./dependency-upgrades.md)).
- **The check run by us is the floor, not the proof.** It catches our own
  drift. The public value comes only from someone else being able to run it,
  so the one-command script and its instructions are part of the feature, not
  a follow-up.

### the claim — what changes when it ships

⚠ **Announce nothing before it ships.** `/security` says "We are not promising
either one is coming", and its source comment rules out "yet" or "coming soon"
on that paragraph. A roadmap line here would be a promise the page explicitly
refuses to make.

**When it ships, what may be said** is the second row of the table, per
platform: anyone can check that the files `app.bracemark.com` serves are built
from a named commit, and here is how. **What still may not be said:**
"verify what you are running", or anything implying that a given page load was
checked. The per-user gap remains, and the copy has to state it, the same way
it states the current gap today. The words _verifiable_ and _transparent_ stay
out, for the reason [brand-assets.md](./brand-assets.md) gives.

**The surfaces that change together**, because the boundary has to read the same
everywhere ([brand-assets.md](./brand-assets.md), _the source — what we may
claim_, whose claim-boundary paragraph is the first thing to rewrite):

- `/security`, _What this page does not prove_
- `/about`, _See for yourself_
- `/faq`, `source` (`src/content/faq.tsx`)
- `/privacy`, _Security_
- the landing page's _If we disappear_ band. Its copy makes no verification
  claim, but its source comment states the boundary, so it moves with it.
- the repo's `README.md` and `SECURITY.md`, which both state the gap

⚠ **Open copy inconsistency, today.** `/privacy` ("reproducible builds we do not
publish yet"), `/faq` `source` ("we don't publish them yet") and `README.md`
("we don't publish them yet") all say **"yet"**. `/security` says we are not promising it is coming. The two can't
both be the stance. Settle it in [brand-assets.md](./brand-assets.md) first,
then make the surfaces agree. It stands whether or not this work goes ahead.

### plan

In order of value per effort. Each step is useful even if the next never
happens.

1. **bracemark-web, one machine:** `generateBuildId` from `BUILD_ID`, then
   confirm two builds with the same supplied id are byte-identical, `sw.js`
   included. Read [offline-mode.md](./offline-mode.md) first.
2. **The compare script:** rebuild a commit with the live `BUILD_ID` and compare
   against the live host, as [above](#comparing-against-the-live-site). Run it
   after each production deploy.
3. **bracemark-extension:** rebuild `zip` and `zip:firefox` at a `chrome/` or
   `firefox/` tag and compare against the package each store serves, signature
   files excluded. It may be the stronger claim, and possibly the easier one.
4. **A second machine and a pinned Node**, for both of the above.
5. **Then the claim**, per platform, on every surface at once.
6. **Android and iOS:** not planned. Name them in the claim as not covered.
