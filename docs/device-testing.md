## device testing — reaching the stack from a real phone or tablet

Which of the six apps each physical device can run, in which of the three
environments, and what has to be true for it to connect. The short version is
that **only `development` needs anything designed at all** — staging and
production are on the public internet, so a device just opens a URL or installs
a build. Everything below is about the local tier.

The neighbours: [env-files.md](./env-files.md) owns the per-app env files and the
local port map, [hosting.md](./hosting.md) owns the deployed origins,
[e2e.md](./e2e.md) owns the scripted runs and the `adb reverse` the Android
emulator needs, and [app-drivers.md](./app-drivers.md) owns why you'd drive a real
device at all rather than a simulator, and what drives it once you do. This doc is the one that answers "I have five
devices on my wifi — what works?"

### the devices

The lab this is written against: a MacBook, an iPhone, an iPad, an Android phone
and an Android tablet, all on the same home wifi. The MacBook runs everything in
every environment and is not interesting; the table is about the other four.

| app                   | iPhone / iPad                      | Android phone / tablet        |
| --------------------- | ---------------------------------- | ----------------------------- |
| `bracemark-expo`      | dev build signed with the UDID     | dev build, installed over adb |
| `bracemark-web`       | browser — **the open decision**    | browser, via `adb reverse`    |
| `bracemark-site`      | browser                            | browser, via `adb reverse`    |
| `bracemark-extension` | **never** — no Safari build exists | Firefox for Android           |
| `bracemark-api`       | — backend, reached by the above    | —                             |
| `bracemark-extractor` | — backend, reached by the above    | —                             |

Two rows in that table surprise people in opposite directions, so both are
written down rather than left to be rediscovered:

- **The browser extension runs on Android and not on iOS.** It looks like a
  desktop-only app and isn't: `wxt.config.ts` declares
  `gecko_android: { strict_min_version: '142.0' }`, so Firefox for Android is a
  shipped target with its own derived floor
  ([browser-extension.md](./browser-extension.md), _the browser floors are
  derived_). There is no Safari target in that config at all — Chrome and Firefox
  are the two branches — so an iPhone or iPad cannot run it in any environment,
  and no amount of local networking changes that. It is a build that does not
  exist, not a connection that does not work.
- **The api and the extractor are never "opened" on a device.** They are what the
  other four talk to, which is why every connectivity question below is really a
  question about one of the clients' baked-in origin vars.

### only `development` needs wiring

Staging and production answer on `dryrunbase.com` and `bracemark.com`
([hosting.md](./hosting.md), _the hosts_) over public HTTPS with public DNS.
Every device reaches them the same way it reaches any other website, and
`bracemark-expo` reaches them the same way it will in the store. So:

| environment   | what a device needs                                              |
| ------------- | ---------------------------------------------------------------- |
| `development` | everything in this doc                                           |
| `staging`     | the URL; for expo, a build with the staging pair in `.env.local` |
| `production`  | the URL; for expo, a release build                               |

That is worth stating plainly because it makes staging the cheap way to answer
"does this work on my iPad" — no certificates, no LAN addresses, no overrides.
Reach for it first, and treat the local tier as the thing you set up when you
need to see an unshipped change on the device.

### ⚠ the constraint that shapes everything: secure contexts

`bracemark-web` **does not work on a plain-`http` origin that isn't `localhost`**,
and it fails in three separate ways at once:

| what breaks           | where                                         | how it looks                              |
| --------------------- | --------------------------------------------- | ----------------------------------------- |
| `crypto.subtle`       | `packages/web-crypto/src/lib/derive.ts`       | `undefined` — every key derivation throws |
| the service worker    | `apps/bracemark-web/src/app/inner-layout.tsx` | registration silently never happens       |
| `navigator.clipboard` | `bulk-edit-toolbar.tsx`, `link-row-menu.tsx`  | copy actions throw                        |

All three are gated on **secure context**, which is `https://` **or**
`localhost`/`127.0.0.1` — and nothing else. In particular `.local` is not a
secure context: a Bonjour name is a convenience for reaching the host, not a
trust statement, and `http://Macs-MacBook-Pro.local:3000` is exactly as
non-secure as the raw IP.

**Nothing in this repo catches it.** It typechecks, it lints, every jest and
vitest spec passes (they run on node and jsdom, which have `crypto.subtle`
unconditionally), and the app builds. The symptom on the device is a `TypeError`
from inside derivation, which reads as a crypto bug rather than a URL bug —
`packages/shared`'s portability suites exist for the sibling failure, a missing
global on an engine (see [testing.md](./testing.md), _the portability suites_),
and this one is the same shape one layer out: a fact about the ORIGIN, not about
the code.

Two things this constraint does **not** touch, both worth knowing because they
shrink the problem:

- **`bracemark-expo` is completely exempt.** It is native, it uses
  `react-native-quick-crypto` rather than WebCrypto, and a native app has no
  secure-context rule and no CORS. Plain `http://<lan-ip>:8787` is correct there,
  not a compromise.
- **`bracemark-site` is exempt too.** It reaches none of the three APIs above, and
  today it makes no runtime call to the api at all — `NEXT_PUBLIC_API_URL` sits in
  its `.env.development` and nothing in `src/` reads it. (env-files.md and
  hosting.md both describe an apex that calls the api for public stats; that is
  the design, not yet the code. When it lands, the site gains web's CORS entry and
  still not its HTTPS requirement.)

### the two ways in

**Android: `adb reverse`, and it is strictly the better option.** It forwards a
port on the device to the same port on the Mac, so the device's own `localhost`
_is_ the Mac — which means the committed `.env.development` files are already
correct, no override is needed anywhere, and `http://localhost:3000` is a secure
context on the phone for free. That last point is the one that matters:
**`adb reverse` is how `bracemark-web` works on Android without a certificate.**
It works over USB or wireless debugging, on a physical device exactly as on the
emulator. `npm run expo:android:reverse` covers 8081/8787/8788 (Metro, api,
extractor); driving the web apps as well means adding 3000 and 3001.

**iOS: the LAN address, because there is no equivalent.** A real iPhone or iPad
is a separate host with no adb, no port forwarding, and no way to be told that
localhost means the Mac. It has to address the MacBook directly — by LAN IP, or
by the Bonjour `<name>.local`, which follows the address across DHCP changes and
is reliable on Apple devices specifically. **Pin the Mac's address with a DHCP
reservation on the router** and the choice stops mattering; that one router
setting removes the whole class of "it worked yesterday".

For the address to be reachable at all, the two Workers must bind more than
loopback. `wrangler dev` defaults to `--ip localhost` while the Next dev servers
default to `0.0.0.0`, which is why a phone can load `:3000` and not `:8787`; both
`wrangler.jsonc` files set `"ip": "0.0.0.0"` in their `dev` block for this reason
([env-files.md](./env-files.md), _the local port map_).

### the LAN address is set in exactly one file

Because the Workers bind `0.0.0.0`, one local api answers on **several origins at
once** — `http://localhost:8787` for the Mac's browser and for Android via
`adb reverse`, `http://<lan-ip>:8787` for the iPhone. So a URL the api _mints_ for
a client can't name a fixed origin: it has to echo whichever one that client just
used. There is one such URL, the local blob proxy that stands in for R2 in dev
(`apps/bracemark-api/src/r2/local.ts` — miniflare's emulated bucket has no
presignable S3 endpoint, so `files/sign` hands out URLs back to the Worker itself).
It builds its origin from the incoming request, which is what keeps the Mac's
address out of the api entirely: **the only file that carries it is
`apps/bracemark-expo/.env.local`**, the gitignored domain switch
([env-files.md](./env-files.md), _bracemark-expo_).

⚠ Hardcoding that origin instead is the silent failure this arrangement exists to
prevent. It is right for every caller except the phone, and on the phone
`http://localhost:8787` is the **phone**: `files/sign` returns 200 with URLs that
look fine, and every blob upload and download then dies on a connection refused
that reads as the api being down rather than as a wrong origin. No lint rule, no
type error, and no test catches it — the vitest runner and the simulator are on
loopback like everything else, so the hardcode is correct everywhere the suite
looks. `routes/sync.spec.ts` now drives one `files/sign` at a non-loopback address
for this reason alone.

### ⚠ one bundle, one set of origins — so it is a mode, not a mix

Every frontend here bakes its origin vars in at **build** time — `NEXT_PUBLIC_*`
by Next, `EXPO_PUBLIC_*` by Metro. There is one value per dev-server session, so
**you cannot serve the localhost devices and the LAN devices simultaneously**.
Working on the iPad is a mode you switch into and back out of.

The switch is a gitignored `.env.development.local` in each Next app, and
`.env.local` in `bracemark-expo` — expo's is not dev-only, because the same file
also picks staging for a release build ([env-files.md](./env-files.md),
_bracemark-expo_). Both loaders resolve these ahead of the committed files and
let them win — verified in `@next/env` and `@expo/env`,
which implement the identical order (`.env.<mode>.local`, `.env.local`,
`.env.<mode>`, `.env`) and both keep the first definition of a key. `.env*.local`
is gitignored at the root, so the committed files stay on `localhost` and the
simulator, the emulator and the e2e runs keep working for everyone else.

**Rewrite every origin var, not just the API one.** This is the quiet half: a
page whose api URL is fixed still renders, and only its cross-origin _links_
break — pointing at the device's own `localhost`, which looks like the dev server
being down rather than a misconfigured var.

| app              | vars that name another origin                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `bracemark-web`  | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_EXTRACTOR_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL` |
| `bracemark-site` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL` (Sign in / Get Started, via `lib/site.ts`)           |
| `bracemark-expo` | `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SITE_URL`                                                     |

Two consequences of the bake:

- **Metro needs `--clear`.** `npm run expo:start -- --clear` after editing the
  file; a reload re-runs the old inlined value.
- **The api's CORS list has to learn the new browser origin**, and the dev
  `CORS_ORIGINS` lives in the committed, public `wrangler.jsonc`. Put the override
  in `apps/bracemark-api/.dev.vars.development` instead — gitignored via
  `.dev.vars.*`, scoped to `--env development`, and it does override the committed
  `vars` (measured). `bracemark-expo` needs none of this: native clients are not
  CORS-bound, which the `wrangler.jsonc` comment already says.

⚠ **Switching back OUT is the half that gets forgotten, and it breaks the two
targets that never needed this file.** Left uncommented, the override still
outranks the committed `.env.development`, so the iOS simulator and the Android emulator
stop using loopback and start addressing the Mac across the network — and the
emulator's `adb reverse` goes with them, because the reverse maps `localhost`
and the bundle no longer says localhost. `npm run expo:android:reverse` then
runs clean and changes nothing, which is why re-running it is not the fix it
looks like.

Whether that works at all becomes a property of the wifi rather than of the
code. **Measured:** on one network the emulator resolved the Bonjour name and
reached the Mac perfectly, so the override is not reliably broken — it is
reliably CONDITIONAL, which is worse, because it keeps working until the Mac
joins a different network, an mDNS query is dropped, a guest network isolates
clients, or a VPN comes up. (Also measured, and a trap while diagnosing: before
`sys.boot_completed` the same emulator answers `unknown host` for a name it
resolves fine a minute later, so a check run against a half-booted device
indicts the wrong thing.)

**The symptom is specific enough to recognise.** The app LAUNCHES and Metro is
healthy — the dev-client deep link and `adb reverse` both address :8081, which
these two vars do not touch — while everything that reaches the api fails as a
network error. So it reads as the api being down, not as an env file being one
comment character short. `npm run e2e:mobile` fails the same way, one layer
further from the cause. And per _Metro needs `--clear`_ above, the repair is not
instant: commenting the two lines back out does nothing until Metro restarts
with a cleared cache, so a reload leaves you testing the old inlined value and
looking for a second bug.

### open decision: `bracemark-web` in `development`, on the iPhone and iPad

**This is the only cell in the matrix that is unresolved.** Everything else in
this doc is work, not a choice. Restating it precisely: iOS has no `adb reverse`,
so the device must use the LAN address; `bracemark-web` needs a secure context;
therefore that origin has to be HTTPS, and something has to issue a certificate
the iPhone and iPad will trust.

Not blocking anything today — `bracemark-site` and `bracemark-expo` work on those
devices over plain http right now, and staging covers "does bracemark-web work on
my iPad" without any of this.

#### approach A — mkcert + Caddy (current lean)

Mint one local CA and one cert covering `localhost`, `127.0.0.1`, the LAN IP and
the Bonjour name; run Caddy as an HTTPS front that terminates TLS and proxies to
the plain-http dev servers behind it. Install and trust the root CA on the iPhone
and the iPad.

- **For:** no account, no third party in the dev loop, works with no internet, and
  nothing about the machine becomes public.
- **Against:** the root CA is a real credential — `rootCA-key.pem` sits unencrypted
  on the Mac and can sign _any_ site for every device it is installed on, so a
  laptop compromise becomes a MITM position on personal phones. It lives outside
  the worktree, and per the credential rule in `CLAUDE.md` that is where it stays.
  The per-device trust step is also two operations on iOS, not one: installing the
  profile leaves it **untrusted** until Settings → General → About → Certificate
  Trust Settings is flipped, and the failure in between is indistinguishable from
  having done nothing.
- **Termination has to be in front, not in the app.** `next dev
--experimental-https` is mkcert with a wrapper (`next/dist/lib/mkcert.js` runs
  `mkcert -install`), and using it directly is a trap: it only wraps the two Next
  servers, so the page goes HTTPS while its `fetch` to `:8787` stays HTTP and is
  blocked as mixed content. Flipping the Workers to HTTPS to compensate then
  breaks `bracemark-expo` on Android, because apps targeting API 24+ do not trust
  user-added CAs without a debug-only `networkSecurityConfig`. A proxy in front
  keeps the Workers on plain http, where the native app still wants them. Two
  smaller things about that flag: its cert covers only `localhost`/`127.0.0.1`/`::1`
  unless `-H` is passed (which also restricts the bind, taking `localhost:3000`
  and the e2e runs with it), and it appends to the tracked `.gitignore` unprompted.

#### approach B — Tailscale

Install the app on the MacBook, iPhone and iPad; `tailscale serve` fronts the dev
ports on `<machine>.<tailnet>.ts.net` with a real Let's Encrypt certificate.

- **The common misreading:** there is no shared certificate. Exactly one cert
  exists, on the Mac, for a real public DNS name; the iPhone and iPad trust it
  from the trust store Apple already shipped, the same way they trust any website.
  Nothing is installed on them. The app is there for **routing** — the `ts.net`
  name resolves to a tailnet-only address — not for trust. That is the exact
  inverse of mkcert, where routing is free and trust is the manual per-device work.
- **For:** no private root CA on personal devices, no per-device trust step to
  repeat on the next device, and it works away from the home wifi. The Android
  devices do not need it at all — they have `adb reverse`. Free tier covers this.
- **Against:** an account and a third-party dependency in the dev loop, a VPN
  toggle on personal phones, and `*.ts.net` certificates are logged in public
  **Certificate Transparency** logs, so the machine name becomes publicly
  enumerable — the same "don't publish inventory" instinct `wrangler.jsonc`
  applies to account ids, at much lower stakes. Name the machine accordingly.

#### what would decide it

The security difference is the only asymmetric one: A puts a signing key capable
of impersonating any site onto personal devices; B does not. Everything else is
preference, and the setup effort is comparable. The lean is toward **A**, on the
grounds that it keeps a privacy-shaped project's development loop free of an
external account and off public CT logs — which is a values call, made
deliberately, with the CA-key exposure accepted and mitigated by keeping the key
off every device that does not need it.

Nothing is configured for either yet. When one is chosen, this section becomes a
_how_ and the alternative stays here as the record of why it wasn't taken.
