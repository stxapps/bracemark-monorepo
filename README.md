# Bracemark

**The bookmark manager that can't read your bookmarks.**

Your password derives a key on your own device. Every link, list, tag and setting
becomes its own encrypted file before it is uploaded, so the server holds a path, a
size and some bytes it has no key for. There is no "we promise not to look" in that
sentence, because there is no looking available to promise against.

This repository is all of it: the web app, the marketing site, the iOS and Android
app, the browser extension, the sync API and the link extractor.

- **Product** — [bracemark.com](https://bracemark.com)
- **App** — [app.bracemark.com](https://app.bracemark.com)
- **Security reports** — security@bracemark.com ([SECURITY.md](SECURITY.md))
- **Our link fetcher** — abuse@bracemark.com ([what it is, how to block it](https://bracemark.com/extractor))

## What being public here does and doesn't prove

It lets you read exactly what we do — where the key comes from, where encryption
happens, and what the server is ever given.

It does **not** let you prove that the JavaScript your browser just ran was built
from this source. That needs reproducible builds, and we don't publish them yet.
Every claim we make about this repo on the marketing site is written to the first
statement, never the second.

## Layout

```
apps/
  bracemark-web        the app at app.bracemark.com (Next.js, static export)
  bracemark-site       the marketing site at the apex (Next.js)
  bracemark-expo       iOS + Android, including the iOS share extension
  bracemark-extension  the browser extension for Chrome and Firefox (WXT)
  bracemark-api        sync + accounts + subscriptions (Cloudflare Workers)
  bracemark-extractor  fetches titles, images and page copies (Cloudflare Workers)
packages/
  shared               platform-agnostic core — types, API contracts, brand lines
  web-crypto           expo-crypto        key derivation and file encryption
  react                web-react          expo-react        hooks and stores
  web-ui                                  the web component library
docs/                  the design record — read the relevant file before changing
                       code in its area
```

Packages layer `shared → crypto → react → ui → app` across a platform axis
(`agnostic` / `web` / `worker` / `expo`), and packages never import an app. Both
axes are declared as Nx tags and enforced by `@nx/enforce-module-boundaries`, so an
illegal import fails `npm run lint` rather than failing silently.
[`docs/architecture.md`](docs/architecture.md) has the reasoning and the per-project
tags.

## Running it

Node >= 24, npm (not pnpm or yarn — the lockfile is `package-lock.json`).

```sh
npm install
npm run dev        # bracemark-web + bracemark-api + bracemark-extractor
npm run dev:site   # the marketing site
npm run dev:ext    # the browser extension
```

Tasks run through Nx. Scope one to a project with its full name — the Nx project
names carry the scope, so it's `@stxapps/bracemark-web`, not the folder name:

```sh
npx nx typecheck @stxapps/bracemark-web
npx nx test @stxapps/shared
npx nx affected -t lint     # only what your change touched
```

Whole-workspace equivalents: `npm run lint`, `npm run typecheck`, `npm run test`,
`npm run build`. Run `npm run fix` (ESLint `--fix` + Prettier) before checking, so
the reports only contain what needs real attention.

Environment variables are per app and per mode — see
[`docs/env-files.md`](docs/env-files.md).

## Docs

`docs/` is the design record rather than generated reference: each file explains
why an area works the way it does, and is updated in the same change as the code.
Start with [`architecture.md`](docs/architecture.md), then the file for the area
you're in — [`local-first-sync.md`](docs/local-first-sync.md) for the data path,
[`account.md`](docs/account.md) for key derivation,
[`api-contracts.md`](docs/api-contracts.md) for the endpoints.

## Contributing

Issues and small, focused pull requests are welcome. For anything larger, open an
issue first — a lot of what looks like a missing feature here is a deliberate
consequence of the encryption (no server-side search, no password reset, no shared
lists), and the reasoning lives in `docs/`.

Please don't report security problems in a public issue; see
[SECURITY.md](SECURITY.md).

## Licence

[AGPL-3.0](LICENSE). If you run a modified version as a network service, the
licence requires you to publish your modifications.

The licence covers the code. If you fork it and run it for other people, we'd ask
that you give it your own name and icon — not because the licence requires it, but
so that nobody ends up trusting your build with their library because they thought
it was ours. That confusion is the only thing we'd mind.

© STX Apps Co., Ltd.
