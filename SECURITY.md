# Security policy

## Reporting a vulnerability

Email **security@bracemark.com**. Please don't open a public issue for it, and
please tell us before you tell anyone else.

Include what you did and what happened — a rough reproduction is worth more than a
scanner report. You'll get a reply from a human. We aim to acknowledge within three
working days and to tell you what we intend to do about it within ten.

We're a small team, so we don't run a bug bounty and can't offer payment. We will
credit you when a report leads to a fix, unless you'd rather we didn't.

## What we're most interested in

Bracemark's central claim is that the server cannot read your library. Anything
that undermines that is the highest-value report we can receive:

- plaintext, keys, or key material reaching the server, or leaving the device by
  any route other than an encrypted file;
- weaknesses in the key derivation or the encryption of synced files
  (`packages/web-crypto`, `packages/expo-crypto`, [`docs/account.md`](docs/account.md),
  [`docs/local-first-sync.md`](docs/local-first-sync.md));
- authentication or authorisation flaws in `apps/bracemark-api` — anything letting
  one account read, write, or delete another's files;
- ways to bypass the app lock or a list lock ([`docs/locks.md`](docs/locks.md));
- SSRF or request forgery through `apps/bracemark-extractor`, which is the one
  component that fetches user-supplied URLs
  ([`docs/link-extraction.md`](docs/link-extraction.md));
- anything letting a web page read the browser extension's stored session
  ([`docs/browser-extension.md`](docs/browser-extension.md)).

## Known and by design

These aren't vulnerabilities, and the reasoning for each is in `docs/`:

- **There is no password reset.** We hold no key, so there's nothing on our side to
  reset with. The recovery code is the second door.
- **The server sees file paths, sizes and modification times.** That metadata is
  what makes sync work; the inventory is in the privacy policy.
- **Link previews saved from the web app pass through our extractor**, opt-in and
  off by default. It holds no key, never sees your account, and stores nothing it
  read — only the IP addresses its rate limiter needs.
- **Subscribing identifies you to the payment provider.** It costs anonymity, not
  confidentiality.

## Scope

`bracemark.com`, `app.bracemark.com`, the API and extractor Workers, and the
published iOS, Android, Chrome and Firefox builds — plus this repository.

Please don't test in ways that degrade the service or touch other people's data:
no load or denial-of-service testing, no automated scanning that generates
significant traffic, and no accounts but your own. Create as many of your own as
you need.

## Reading the source

The whole product is public here under the AGPL-3.0, which means you can read
exactly what the code does. It doesn't, on its own, prove which build was served to
a given client — we don't publish reproducible builds yet. If you find a
discrepancy between what a shipped bundle does and what this repository says it
does, that is very much a report we want.
