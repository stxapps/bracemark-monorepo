## account & key derivation

How a bracemark account works: there is **no account on the server** in the
traditional sense — the user's `(username, password)` pair _is_ the account.
From it the client deterministically derives a **key-encryption-key** that
unwraps a random **data key**, and from that data key it derives every key it
needs. See [architecture.md](./architecture.md) for package layering,
[api-contracts.md](./api-contracts.md) for how the create-account endpoint is
typed, and [local-first-sync.md](./local-first-sync.md) for what the derived
encryption key protects. The crypto implementation lives in
`@stxapps/web-crypto` (web + extension) and `@stxapps/expo-crypto` (the Expo
client — native Argon2id/HKDF/AES-GCM via react-native-quick-crypto, plus the
`BracemarkFileCrypto` native module for file-level encryption); the frozen
parameters and validators live in `@stxapps/shared` (`crypto/params.ts`,
`auth/credentials.ts`).

### the model: a password-unlocked wallet, with extra doors

> ⚠ **"Password-unlocked", never "password-derived" — the name above is a shape,
> not a mechanism.** The password _opens_ the wallet; it does not _make_ the key.
> The root is a **random DEK** ([the DEK / KEK door model](#the-dek--kek-door-model)
> below); the password derives only a **KEK**, which unwraps a copy of it. So any
> sentence saying the encryption key is _derived from_ your password is false —
> and false in a way that contradicts itself one clause later, because a key
> genuinely derived from the password could not also have a recovery-code door.
> This heading read "password-derived wallet" for a long stretch, and that wording
> was copied out of here onto **eight** user-facing surfaces, /terms, /privacy and
> the store listings among them. In user-facing copy the verb is **unlocks**.
> "Password-derived" remains correct for the KEK itself, and as a name for the
> account _model_ — say which one you mean.

bracemark is an **end-to-end encrypted** bookmark manager: the server never sees
the password, the data key or any private key, and never sees your library in
plaintext. Not "the server stores only ciphertext" — `bracemark-api` also holds
your username, your public key, your sessions and your subscription row in the
clear ([local-first-sync.md](./local-first-sync.md), _the shape of the problem_,
for why that shorthand is barred in every surface that repeats it). What is
ciphertext-only is the library, plus the key material this file is about. That
makes the account model structurally identical to a **crypto wallet**:

- the secret **is** the account — no email, no server-side password reset;
- each **door** derives its key **deterministically**, the same way every time,
  on every device — though the DEK it unwraps is random, and is fetched (wrapped)
  rather than recomputed;
- the default door is the password, and **if it is the only door, there is no
  recovery** — lose it and the data is gone, exactly like a wallet seed phrase.

The one place it differs from a wallet is the part that matters most — **where
the entropy comes from** — and that difference drives every rule below.

|                     | 24-word seed (BIP-39)         | bracemark `(username, password)`                            |
| ------------------- | ----------------------------- | ----------------------------------------------------------- |
| entropy source      | **forced random** (~256 bits) | **user-chosen** — whatever they pick                        |
| offline brute force | infeasible, period            | feasible **if the password is weak**                        |
| per-guess cost      | —                             | Argon2id (64 MiB, ~1–3s) — raises cost, **adds no entropy** |
| recovery            | none                          | optional — see [the doors](#the-doors)                      |

A wallet _forces_ high entropy; bracemark _trusts the user_ to choose it. Argon2id
(memory-hard) makes each guess expensive — this is what defeated the old
SHA-256 "brain wallets" that got drained — and the per-user salt stops shared
rainbow tables. But neither manufactures entropy: **the security of the password
door is bounded by the entropy of the password.** A generated 7-word passphrase
approaches wallet-grade; `Summer2026!` does not.

> The product goal is _wallet-grade safety with better UX_. Two things buy that:
> (1) steering users toward enough password entropy (see [generated
> password](#generated-password-recommended-default)), and (2) the **DEK door
> model** below, which lets us add a recovery code / passkey as _additional_
> doors without giving the server the ability to decrypt anything. UX
> convenience must not quietly become a weak-key generator.

### the DEK / KEK door model

The root of an account is **not** the password. It is a random **DEK** (data
encryption key) — 32 bytes from a CSPRNG, generated once at create-account and
never derived from anything. The keypair and encryption key are derived from the
**DEK**; each access method ("door") derives a **KEK** (key-encryption-key) that
**wraps** (AEAD-encrypts) its own copy of the DEK:

```
                         random DEK  (32 bytes, the real root)
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
   password-KEK      recovery-KEK        passkey-KEK      ← each door derives a KEK
        │                 │                  │
   wrap(DEK)         wrap(DEK)           wrap(DEK)        ← N wrapped blobs,
        │                 │                  │              stored server-side (ciphertext)
        └────── any one unwraps ──▶ DEK ─────┘
                                     │
                                     ├─ HKDF(info="bracemark-auth-seed") ──▶ Ed25519 keypair
                                     │                                     ├─ publicKey  (credential, sent)
                                     │                                     └─ sign()     (private key, never leaves the module)
                                     └─ HKDF(info="bracemark-encryption-key") ──▶ AES-256-GCM key (non-extractable, never sent)
```

Any single door unwraps the same DEK; the DEK derives everything else.

**Why a DEK instead of encrypting the data once per door:** the indirection lets
us **encrypt the data once and open it through many cheap, independently
revocable doors.** Data is encrypted under the DEK; each door wraps only the
32-byte DEK. Adding/removing a door, or changing a password, re-wraps 32 bytes
and **never touches the data**. Without it, every door would have to encrypt all
the data and a password change would re-encrypt everything.

The wrapped blobs are ciphertext, so storing them server-side is safe — the
server holds locked boxes it can't open. It hands a door's blob to anyone who
asks for a username (it's needed _before_ auth); that exposure is the same as
today, where an attacker with the `publicKey` or any ciphertext can mount an
offline Argon2id attack on a weak password.

### the doors

| door              | input entropy     | KDF for the KEK                                   | when                   |
| ----------------- | ----------------- | ------------------------------------------------- | ---------------------- |
| **password**      | low (user-chosen) | **Argon2id** (memory-hard) over the per-user salt | always (primary) — ✅  |
| **recovery code** | high (CSPRNG)     | **HKDF** (input already high-entropy)             | ✅ built (skippable)   |
| **passkey**       | high (PRF secret) | **HKDF** over the WebAuthn PRF output             | later, where supported |

- **password door** — `password-KEK = Argon2id(canonicalizePassword(password),
salt)`, where `salt = SHA-256(APP_SALT ‖ canonicalizeUsername(username))` (the
  per-user salt described below). Memory-hard because the input is low-entropy.
  `canonicalizePassword` (`shared` `crypto/params.ts`) is `trim().normalize('NFC')`
  — part of the frozen contract, so every platform folds it identically before the
  KDF. It differs from the username's `NFKC`+`toLowerCase` on purpose: a password
  is a secret, so we use **canonical** NFC (entropy-preserving, unlike lossy NFKC)
  and keep case, per RFC 8265's OpaqueString profile. `trim()` closes the
  unrecoverable "invisible trailing space at signup" lockout (there is no reset);
  NFC makes a password typed as precomposed `é` vs decomposed `e`+U+0301 derive one
  KEK across keyboards/platforms. On the ASCII generated passphrase it is a no-op.
  (The generated passphrase joins its words with **`-`**, not spaces — a hyphen is
  a single token to keyboards/autocorrect, avoiding the space-re-entry footgun;
  see `generatePassphrase`.)
- **recovery code** — generated with `crypto.getRandomValues` (≥256 bits, shown
  once as grouped **Crockford base32**). Already high-entropy, so a cheap
  `recovery-KEK = HKDF(normalizeRecoveryCode(code), info="bracemark-recovery-kek")`
  suffices. The KDF runs over the **normalized** string (uppercase, hyphens
  dropped, Crockford confusables `O→0`/`I,L→1` repaired), so a code typed with its
  display grouping still unwraps. Generator + normalizer are in `shared`
  (`crypto/recovery-code.ts`) so web and native produce/parse the identical form.
- **passkey** — needs the **WebAuthn PRF extension** (built on `hmac-secret`):
  the authenticator returns a stable per-credential pseudorandom secret, and
  `passkey-KEK = HKDF(prfSecret, …)`. A plain passkey only _signs_ — it can't
  decrypt — so PRF is what turns it into a door. PRF is on Chrome + Safari with
  platform authenticators but not universal; fall back to password/recovery
  where it's missing. A platform passkey synced via iCloud Keychain / Google
  Password Manager is a **per-device door the platform backs up for free** — the
  door users are least likely to lose.

**Wrapping format.** Wrap with an **AEAD** (AES-256-GCM) so a wrong/tampered
blob fails cleanly, and bind each blob to its door with the AAD so a malicious
server can't pass off one door's blob as another's:

```
blob = AES-256-GCM(key = KEK, plaintext = DEK, aad = doorType)
stored per door: { doorType, iv, ciphertext+tag }
```

The AAD is **only the `doorType`, deliberately not the user.** The KEK already
binds the user — the password door folds the username into its salt (so a
cross-user blob unwraps with a different KEK and fails the GCM tag anyway), and
the recovery/passkey KEKs come from a per-user secret. Re-binding the user in the
AAD would be redundant _and_ would couple every door to the username, so a future
username change (which by design re-wraps only the password door) would have to
re-wrap the username-independent doors too. `doorType` is the one piece of
context not already carried by the KEK, so it is the whole AAD. (Defined once as
`dekWrapAad` in `crypto/doors.ts`, part of the frozen contract.)

> **Security floor = the weakest door.** An attacker takes the easiest of the
> doors, so every door must be strong: the recovery code CSPRNG-generated, the
> passkey hardware-backed. The recovery code is the one humans mishandle —
> generate it, never let users type their own.

### rotation & revocation — two tiers

| tier              | trigger                                             | work                                                                                                      | publicKey / data |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| **door rotation** | change password, add/remove recovery, revoke device | re-derive that one KEK; re-wrap or **delete** that blob                                                   | **unchanged**    |
| **DEK rotation**  | DEK believed exposed                                | new DEK; re-derive keypair (**publicKey changes**) + enc key; **re-encrypt all data**; re-wrap every door | changes — rare   |

Revoking a device is just deleting that door's wrapped blob (plus its `sessions`
row) — no re-encryption, as long as the DEK itself wasn't exposed.

> **STATUS — door rotation ✅ built; DEK rotation not.** Change-password and
> generate/regenerate-recovery are wired as tier-1 rotations: prove an existing
> door (current password **or** recovery code) to recover the DEK, re-wrap it, and
> `upsert` that one `account_keys` row — the publicKey and data are untouched.
> **Sessions:** change-password additionally **revokes every other session**
> (keeping the caller's own — the UI stays signed in on this device) via
> `sessions.deleteByUserIdExcept`: a password change can't un-leak already-copied
> data, but it cuts off ongoing access, so whoever had the old password loses both
> the ability to mint new sessions and any session they'd already minted.
> Regenerating a recovery code does **not** touch sessions (it isn't a "someone may
> be in my account" action; it only invalidates the old code). The same
> except-current primitive backs **"sign out other devices"** (POST
> `/v1/auth/sign-out-others`, `useSignOutOthers`): session-only (`requireAuth`, no
> fresh proof — the plural of sign-out, low-harm and reversible), it revokes every
> other session and keeps the caller's own.
> Endpoints POST `/v1/auth/change-password` and POST
> `/v1/auth/recovery-door` (`routes/auth.ts`, `services/account.ts`), each
> double-guarded like delete-account (bearer token **and** a fresh signed proof, so
> a stolen session alone can't rotate a door); client crypto
> `changePasswordDoor` / `regenerateRecoveryDoor` (`web-crypto/derive.ts`), hooks
> `useChangePassword` / `useRecoveryCode`. **DEK rotation is deferred** (own
> project) — see the leaked-password note next.

> **A leaked password needs DEK rotation, not a password change.** Changing the
> password is only a door rotation: the DEK is **unchanged**, and the wrapped blob
> is served pre-auth, so an attacker who learned the password can still fetch a
> blob and unwrap the same DEK — deleting the old password-door row server-side
> can't un-capture a copy they already pulled, and an attacker who already
> unwrapped the DEK keeps it forever (it derives the credential + encryption key).
> So the real remedy for a suspected compromise is **DEK rotation** (tier-2): mint
> a new DEK, re-derive the keypair (**publicKey changes**), **re-encrypt all
> data**, re-wrap every door, and revoke all sessions. That touches the sync
> engine, so it is its own project — surfaced later as a settings "Reset account
> security" action. Honest limit: rotation locks the attacker out going forward
> but **cannot** re-protect ciphertext they already exfiltrated — which is exactly
> why steering users to a high-entropy passphrase up front matters most.

### the derivation pipeline

One synchronous pass, run inside a Web Worker (Argon2id is ~1–3 s of CPU, kept
off the main thread). On **sign-in**:

```
(username, password)
        │  salt = SHA-256(APP_SALT ‖ canonicalUsername)
        ▼
   Argon2id(password, salt)  ──▶  password-KEK
        │
        │  AEAD-unwrap the fetched password-door blob   (wrong password fails on the GCM tag)
        ▼
       DEK (32 bytes)
        │
        ├─ HKDF(info="bracemark-auth-seed") ──▶ Ed25519 keypair → publicKey, sign()
        └─ HKDF(info="bracemark-encryption-key") ──▶ AES-256-GCM key
```

On **create-account** the DEK is generated fresh (not unwrapped), then wrapped
under each chosen door.

- **Per-user salt** — `SHA-256(APP_SALT ‖ canonicalizeUsername(username))`.
  Folding the unique username in means two users who pick the _same_ password
  derive different `password-KEK`s, with nothing stored server-side beyond the
  wrapped blob. `APP_SALT` is the app-wide domain separator against precomputed
  tables shared across apps. The username is a **public, deterministic** salt:
  it de-duplicates passwords but doesn't hide a targeted user, so the real cost
  against a focused attacker is Argon2id's memory-hardness, not the salt.
- **`DEK`** and the derived sub-keys never leave `@stxapps/web-crypto`; only the
  public key / signatures cross the boundary.
- **`publicKey`** is the Ed25519 public key (hex). It is a **credential**, not an
  identifier — see [the two identifiers](#the-two-identifiers).

These parameters are a **frozen cross-platform contract** in `crypto/params.ts`:
web, extension, and the Expo client must all use the exact same
`APP_SALT`, `ARGON2_PARAMS`, HKDF labels, AEAD scheme, and `canonicalizeUsername`
rule, or a door fails to unwrap the DEK and the user is locked out. **They can
never change once real users exist.** (The DEK is random, so it is _not_ part of
the frozen contract — only the machinery that derives KEKs and unwraps it is.)

**Until launch, "never" has an exception — and it expires.** The rule protects
_existing users' keys_, and there are none yet, so these constants were in fact
rewritten during the rename (`bracemark.app-salt.v1.…`, `bracemark-auth-seed`,
`bracemark-encryption-key`, `bracemark-recovery-kek`) at the cost of
regenerating every golden vector below. That is a greenfield licence, not a
standing one: **once real accounts exist, rotating a constant means minting a
`.v2.` label beside it, never editing this one.**
The contract is pinned by **golden vectors** (`crypto/contract-vectors.ts` in
`@stxapps/shared` — salt, KEK, wrapped password door, **recovery-KEK + wrapped
recovery door**, derived keys, signature, packed blob, and a **passphrase
wordlist hash** pin, generated once from the real web pipeline): both
`web-crypto`'s and `expo-crypto`'s specs assert the same vectors, so a platform
that drifts fails CI instead of locking users out.

### username — rules and why

Defined once in `auth/credentials.ts` (`usernameSchema`) and enforced
identically on the form and the server:

| rule             | value                                        | why                                                          |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------ |
| length           | **3–32** chars                               | short enough to type, long enough to be distinct             |
| charset          | `[a-zA-Z0-9_-]`                              | unambiguous, URL-safe, no Unicode confusables in the handle  |
| shape            | alphanumeric groups joined by one `_` or `-` | no punctuation-only, leading, trailing or doubled separators |
| canonicalization | `trim → NFKC → lowercase`                    | one deterministic form (`canonicalizeUsername`)              |
| reserved names   | `RESERVED_USERNAMES` set                     | no account can impersonate the product or a system/role      |

The **length floor is an identity choice, not a security one**: the username is
the salt, but a salt needs to be _unique_ (the server's `UNIQUE` handle
guarantees that) not high-entropy, and `APP_SALT` supplies the cross-app
namespace — so a 3-char handle is a perfectly strong salt and a longer minimum
would buy no security. The **reserved-name blocklist** _is_ the meaningful
username hardening: exact-match (so `admin123` is fine) against the CANONICAL
form, so casing can't smuggle a reserved handle past. It lives in `usernameSchema`
and therefore holds on the **server** too (every auth endpoint validates it).

The two separators support natural multi-word handles without admitting the
larger punctuation and Unicode surface. Requiring an alphanumeric group on each
side keeps the public handle readable and prevents names such as `___`, `_alice`,
`alice-`, or `alice--01`; `_` and `-` remain distinct rather than canonicalizing
to one another.

The set covers **two products, deliberately**: the legacy spellings `brace`,
`braceto`, and `braceapp` stay reserved alongside the `bracemark*` entries, so
neither this app's name nor its predecessor's can be impersonated by an account
handle while the two coexist.
They were not cleaned up during the rename and should not be.

The username does double duty: it is the **public handle** (the server's
case-insensitive `UNIQUE` key) _and_ the **password door's salt input**. Because
the canonicalization rule is folded into KEK derivation it is part of the frozen
contract. But note the DEK model **decouples the username from the data**: it
salts only the `password-KEK`, not the DEK. So a rename re-derives that one KEK
and re-wraps the DEK — it does **not** re-key data — which makes an editable
username feasible later if we want it (re-wrap + update the `UNIQUE` handle),
rather than "create a new account and migrate." Until that's built, treat it as
effectively permanent.

On **account deletion** the username is **tombstoned, never released**: the
directory row stays (with `deleted_at` set), so the handle can't be
re-registered and mistaken for the previous owner, and sign-in answers for it
exactly as for a name that never existed. Release-after-cooldown is a policy we
can loosen into later — never the reverse. See
[data-lifecycle.md](./data-lifecycle.md).

### password — rules and entropy

There are **two** length schemas, on purpose — length plays a different role at
sign-in than at create-time. Read them as a _length_ floor and a hashing bound,
**not** a security guarantee:

- **`passwordSchema` — sign-in (8–128).** Permissive by design: at sign-in,
  length is **not** a security control (the credential check is the door's GCM tag
  failing to unwrap); `min 8` only pre-filters obviously-empty input before an
  expensive Argon2id. It must **never** be raised above the shortest creatable
  password, or it locks valid accounts out — and there is no reset.
- **`newPasswordSchema` — create / change (`NEW_PASSWORD_MIN_LENGTH` = 20 … 128).**
  The policy floor for the typed-your-own path. A hard length floor is
  defense-in-depth **behind** the zxcvbn gate (zxcvbn is a heuristic and can be
  fooled; length can't be tricked past), which matters because a human-chosen
  8-character password is routinely ~20–30 bits and brute-forceable offline once an
  attacker has the `publicKey` or any ciphertext. Kept separate from the sign-in
  schema so tightening it later never strands an existing shorter password. Cheap
  in UX terms: the default is the generated ~77-bit passphrase, so this only bites
  users who insist on typing their own. 20 is not independent of the entropy gate
  below — see `PASSWORD_MIN_GUESSES_LOG10`.
- **max 128** bounds the Argon2id input; well above any real passphrase.

Rough entropy targets, for calibration:

| secret                                       | approx. entropy | verdict                            |
| -------------------------------------------- | --------------- | ---------------------------------- |
| human "strong" password (`Summer2026!`)      | ~25–35 bits     | **weak** — do not rely on it       |
| 7-word BIP-39 passphrase (generated default) | ~77 bits        | **good** — approaches wallet-grade |
| 8-word BIP-39 passphrase                     | ~88 bits        | strong                             |
| BIP-39 24-word seed                          | ~256 bits       | wallet reference point             |

> **STATUS — ✅ built (typed path).** On the "type my own" path the create-account
> form — and Settings → change password, which renders the same component
> (`NewPasswordField`, below) — runs **zxcvbn** (`@zxcvbn-ts`, dynamically imported
> so it stays out of the initial bundle; the CANONICAL password is scored, and the
> username is fed as a penalty term on both)
> and **disables submit below `PASSWORD_MIN_GUESSES_LOG10`** — 10^18
> guesses ≈ 60 bits — with a strength meter
> (`web-ui/components/auth/password-strength.tsx`), alongside the
> `newPasswordSchema` 20-char floor above. The **generated** path is ~77 bits by
> construction and bypasses the gate.
>
> **Gate on `guessesLog10`, never on zxcvbn's 0–4 `score`.** The score is a
> 5-bucket label over the same estimate, and its top bucket is open-ended
> (`guesses >= 1e10` ≈ 33 bits) — measured, score 4 covers everything from
> `Summer2026Bracemark!` (~35 bits) to the generated 7-word passphrase (~121 bits). A
> `score >= 3` gate therefore admitted ~27 bits, which behind Argon2id (64 MiB,
> t=3) is hours on a single GPU. `guessesLog10` is uncapped and is the real signal.
> The meter still displays the score, but `usePasswordStrength` clamps it to
> sub-passing whenever either floor blocks submit, so meter and gate stay one signal
> (no "green meter, disabled button").
>
> **Which dictionaries the estimate is scored against is part of the gate.** zxcvbn
> models anything it fails to match as 10^length, so with the 20-char floor above, a
> password the dictionaries miss clears 10^18 on **length alone** — the dictionary
> set is therefore not a detail of the library, it is the policy. Both language packs
> load: `@zxcvbn-ts/language-common` (49k leaked passwords + the 7.8k-word EFF
> diceware list) **and `@zxcvbn-ts/language-en`** (26.7k common words, 4.9k first
> names, 88.8k last names, 29.8k wikipedia titles). `en` was missing at first, and the
> hole was exactly the shape you'd expect — measured against the 18 floor,
> `thequickbrownfoxjumps` scored 19.1 and **passed**, `ilovemydogsomuchyess` 18.1 and
> **passed**; with `en` they score 15.6 and 17.6 and are refused. Nothing failed while
> it was missing: it lints, types and tests clean, and the only symptom is a weaker
> gate. Hence `loadPasswordScorer` is exported from both platform copies and pinned by
> a spec on each side (`password-strength.spec.ts`, web-ui and bracemark-expo), which
> drives the real loader over that same corpus — a pack pruned from one manifest can't
> pass. This does not make the estimate sound; it closes the part of the overestimate a
> shipped dictionary can close. The rest is what the 60-bit headroom is for.
>
> **The meter's top band is green, and the field always says something.** The bands
> run destructive → amber → emerald, bar fill and label sharing one tone per band;
> the top band is a literal green rather than `bg-primary`, which is a chroma-0
> neutral and so filled a _passing_ meter with black on white (and near-white on
> black in dark mode, where it barely separates from the unlit track) — no success
> signal at all. Underneath it, username and password each keep a permanent message
> line whose every state is filled, resting state included: the states cycle on
> almost every keystroke, so a message that only exists sometimes reflows the card
> under the user's hands, and — the substantive half — a conditional chain hides its
> own gaps. The old one had two: a username the server reported **taken** printed
> nothing while Continue sat disabled, and so did a valid-length password while
> zxcvbn was still loading. A slot that must always say something turns both into
> code you can see. The live availability verdict is also gated on the query
> answering the name **currently** in the field — it lags by the 400ms debounce, and
> "Username is available" about a name already typed past is the one direction that
> line must never be wrong in.
>
> **A third gap was the same shape, one level down: the estimator that never
> arrives.** zxcvbn reaches web as a code-split chunk over the network (~800 KB
> gzipped, ~1.7 MB raw — `language-en` is most of it), so it can be lost to a dead
> connection or 404 against a stale build after a deploy. The load had no `catch`, so
> that rejection went unhandled and the scorer stayed absent for good: the field held
> the in-flight rung, "Checking strength…", and submit stayed disabled with no way
> out — a permanent state wearing a self-resolving message, which is exactly the
> failure the always-say-something slot exists to prevent, reached from the one
> direction the slot couldn't see. `usePasswordStrength` now reports `failed`
> alongside the (still null) score, and the ladder splits the two: `Couldn't check.
Try again.`, `warn` — the same sentence and the same tone as the username ladder's
> transient-failure rung, because it is the same event. The gate is unmoved; no
> estimate never opens it. **Typing is the retry** — the hook re-imports on the next
> keystroke, serialized so a fast typist can't stack attempts — which is what makes
> that sentence literal without spending the slot's ~33-character line on a button.
> This is the ladder's one platform-conditional rung, and deliberately so: native
> `require()`s the packs out of a bundle already on disk (Metro has no code
> splitting), where the equivalent failure is a broken app binary, not a field state.
>
> Both ladders live in `@stxapps/react` (`lib/field-messages.ts`) —
> `usernameMessage` and `newPasswordMessage`, one copy for web and native alike, so
> the same input can't be described differently on two platforms or between
> create-account and change-password. Only the tone→class map is per-platform
> (`MESSAGE_TONE`, beside each platform's strength meter, so a passing message is the
> same green as a passing meter).
>
> **Every rung has a width budget of ~33 characters, and nothing enforces it.** The
> permanent slot removes reflow only while every state renders on ONE line, and line
> count is a property of string × width, not of the string — so the budget has to be
> set by the narrowest surface, which is not the one the card is designed against.
> Web's auth card is `max-w-sm`, so its message slot is 334px only above a ~430px
> viewport; it tracks the viewport below that (293px at 390px, 223px at 320px — and
> 320px is the reflow width [WCAG 1.4.10] as well as what 200% zoom on a 640px window
> gives). Native is narrower still and scales text to 1.3× on top
> ([accessibility.md](./accessibility.md), _font scaling_), leaving ~185px effective.
> A rung over budget wraps, and a slot that changes height walks the submit button
> down the form — the exact failure the permanent slot exists to prevent, reintroduced
> on the surfaces least able to spare the space. Nothing catches it: lint, types and
> tests all pass, and the symptom only appears on a phone.
>
> Eight of the fifteen strings were over when this was first measured, the widest at
> 337px, and the passing rung cleared the old (mistaken) ~335px reading of the rule by
> a single pixel. Two consequences worth keeping: the messages on the credential
> schemas in `shared` are bare predicates rather than sentences with a subject ("At
> least 3 characters." over "Username must be at least 3 characters") because they
> only ever render under the field that already carries the label; and the **passing**
> rung says `Save it somewhere safe.` rather than naming a password manager or
> repeating the meter's verdict. The meter is always directly above the line and owns
> the verdict — doubling it also overclaims, since zxcvbn is a weakness detector, not
> a strength certificate — and prescribing a manager both presumes the user has one
> and is narrower than the app's own answer (the marketing site's FAQ: a manager is
> best, a locking notes app or paper both work). "Somewhere safe" is the phrase the
> rest of the ceremony already uses.
>
> **Each ladder is also the gate for its field.** `tone === 'ok'` is exactly
> `newPasswordSchema` passing _and_ `guessesLog10 >= PASSWORD_MIN_GUESSES_LOG10` for
> the password, and a valid, settled, CURRENT "available" for the username. Callers
> read the verdict off the message instead of re-deriving those conditions beside it,
> so a disabled button can't end up under a line saying everything looks fine. Note
> what this makes strict on purpose: while availability is refetching, the field says
> "Checking availability…" and submit is closed, because the button should agree with
> the sentence rather than with a cached answer the line no longer stands behind.
>
> **`tone` carries two signals, and is not a severity scale.** `ok` is the gate
> above. `error` is separately what both forms spell `aria-invalid` / `data-invalid`
> as — a claim to a screen reader that the value the user _typed_ is rejected
> ("Username, invalid entry"), plus the destructive border. So the rung for an
> availability request that **failed** — offline, server down, non-2xx — is `warn`
> (the app's status-amber, the meter's "Fair" pair and expo's
> `ErrorText tone="warning"`), which is neither: it blocks, because the name can't be
> confirmed, but it must not mark a possibly-free name invalid and send the user to
> re-type the one thing that isn't wrong. `muted` is the resting and in-flight rungs,
> which also block but clear themselves — and that is why `warn` exists rather than
> reusing it, since leaving a stuck state `muted` made it look exactly like the two
> that need nothing from the user.
>
> That failure rung reads `isError` specifically, which is what separates it from the
> **unsettled** one underneath: no data and no error is the frame between mount and
> fetch start, or a request aborted by a newer keystroke, and it says "Checking
> availability…" like the debounce rung above rather than claiming anything broke. It
> is worth knowing why there is no third case here — `enabled` gates on the canonical
> name while the ladder parses the raw one, but `usernameSchema` is ASCII-only and
> canonicalizes inside its own reserved check, so trim→NFKC→lowercase is identity on
> anything that already parsed. A raw pass is a canonical pass, and a **disabled**
> query can therefore only sit behind the invalid-format rung, never reach these two.
>
> Two caveats worth knowing. zxcvbn models an unmatched password as **10^length**
> guesses — ~3.32 bits/char, **independent of charset** — so it _underestimates_
> truly random strings (a 16-char CSPRNG password is ~95 bits but models as 53, and
> is rejected here) and character-class rules would not move the number at all.
> That's the concrete reason this app has **no composition rules** (and NIST
> SP 800-63B advises against them anyway). Conversely it can _overestimate_ patterned
> passwords its dictionaries miss — it can't know the user's dog's name — which is
> what the 60-bit headroom buys. Both caveats argue the same thing: the estimate is a
> weakness detector, not a strength certificate, which is why the **generated**
> passphrase is the default and the typed path is only an escape hatch.

### every field that takes a secret reveals it

`PasswordInput` — `web-ui/components/auth/password-input.tsx`, ported at
`bracemark-expo/features/auth/password-input.tsx` — is the **only** spelling of a
secret field on either platform. A masked input hides the one thing that would let
a user fix a typo, and this account model has no reset: a mistyped secret at
create-time permanently locks the data encrypted under it, and at sign-in the only
feedback is a failure message that can't say _which_ character was wrong. NIST
SP 800-63B says the same thing from the other side — verifiers SHOULD offer to
display the entered secret — and it's why there is no separate "confirm password"
input at the field level: same typo protection, half the typing, and it composes
with the generated-passphrase path below.

The rule is **universal, and that is the point.** It covers both auth forms,
`NewPasswordField` (create + Settings → change password), the current-password and
recovery-code doors, the fresh-password proof on delete-account, and both lock
surfaces — `LockPane` and `LockPasswordDialog` on both platforms
(`docs/locks.md`). The lock dialog is the one where the toggle is load-bearing
rather than pleasant: it _creates_ a secret with no recovery path at all, so a
typo there costs a sign-out that wipes every lock. Those six sites spent a stretch
on a raw `Input` instead, which put an eye on `/signin` and no eye on the
delete-account confirm two clicks away — the same secret, typed into two fields
that disagreed about whether it could be checked.

Two things the component settles, neither of which lints:

- **Callers must not pass `type="password"` / `secureTextEntry`.** Both ports
  spread `{...props}` _after_ their own, so a leftover one wins: the field stays
  masked while the eye keeps flipping its `aria-label` / `aria-pressed`. The
  toggle looks present and does nothing.
- **The reveal is per-mount `useState`, default off, and must not become a
  persisted preference.** On the auth screens that's merely tidy; on the lock
  surfaces it's the threat model, which `docs/locks.md` names as a friend
  scrolling your unattended phone — i.e. exactly the person standing next to the
  screen the toggle would have left revealed.

### generated password (recommended default)

> **STATUS — ✅ built.** The create-account form is a three-step "Secure your
> account" ceremony (`web-ui/components/auth/create-account-form.tsx`).

The cleanest way to get wallet-grade entropy with better-than-wallet UX is to
**offer a generated passphrase as the default**, and let users override with
their own only behind a strength gate. As built:

- **generated 7-word passphrase is the default** (~77 bits), from the BIP-39
  English wordlist (2048 words = 11 bits each, unbiased 11-bit sampling) via
  `crypto.getRandomValues` — never `Math.random`. `generatePassphrase` lives in
  `shared` (`crypto/passphrase.ts`) so native shares it; the wordlist is pinned by
  a hash golden-vector so it can't silently drift. The words are just a
  high-entropy `password` and flow through the password door unchanged — **no
  derivation change**, only UI;
- presented wallet-style: shown once, **Copy** + an **"I've saved this"** checkbox
  that gates continuing, and a plain "there is no reset" warning. A **"type my
  own"** escape hatch swaps to the zxcvbn-gated typed path above. The panel is one
  action per row, and **the row order is the script**: the secret full-width →
  the controls that change WHICH secret you get (Regenerate, "Choose my own") →
  **Copy, full-width** → the checkbox → the step's primary button. Two reasons it
  is not the ordinary "field with a copy glyph beside it". Copy is not a
  convenience here, it IS the step — the panel exists to get the secret into a
  password manager, so it gets a full-width labelled button rather than the
  weakest affordance in the kit, and the label carries the "Copied" state in words
  instead of only in an `aria-label`. And Regenerate goes **above** Copy because it
  silently invalidates a copy already taken: the clipboard would still hold the
  old secret with nothing on screen saying so. Settle, then commit. (Regenerating
  also resets both the checkbox and the "Copied" affordance.) The panel is
  `ShowOnceSecret` in `web-ui/components/auth/` with a native twin in
  `bracemark-expo/src/features/auth/`; the settle controls are passed in per call
  site through its `actions` slot, since the recovery panel in Settings has none;
- **the whole choose-a-password block is ONE component per platform** —
  `NewPasswordField` + `useNewPassword`
  (`web-ui/components/auth/new-password-field.tsx`, native twin in
  `bracemark-expo/src/features/auth/`). It owns the generated/typed choice, the
  `ShowOnceSecret` panel, the meter, the message line and **the gate**: the hook
  returns `{ password, ok }`, and a caller spells its submit's `disabled` as `!ok`
  and nothing else. Two surfaces render it — create-account's setup step and
  Settings → **change password** — and they carried near-verbatim copies of it
  until those drifted: Settings scored the typed password with **no penalty terms**
  while create-account fed it the username, so a username-derived password could be
  rejected at signup and accepted at rotation. Both pass `username` now. The words
  all four surfaces print sit one layer further down again, beside the message
  ladders (`NEW_PASSWORD_COPY`, `react/lib/new-password-copy.ts`) — two components
  × two platforms is more copies than prose survives, and the typed-path paragraph
  had already lost its "there is no way to reset it if it's lost" clause on the
  Settings side. On web the component renders the **Field kit** even though the
  rest of Settings hand-rolls a `Label` over a `flex flex-col gap-2` column:
  `Field`'s vertical variant _is_ that column, so nothing moves, and this block
  wants the `data-invalid` cascade the kit gives it. That Field-vs-`Label` split is
  otherwise **per surface** and deliberate — auth forms use the kit, Settings and
  the link editors don't (`web-ui/components/ui/field.tsx`);
- a **confirm step** re-enters the password (verifying the user can reproduce it —
  there is no reset), then a **skippable recovery-code step** (show-once, same
  wallet panel). Skipping starts the account password-only; a **"no recovery set"
  nudge** then lives in Settings → Account. The optional recovery door rides in the
  same signed create-account payload (`createAccountPayloadSchema.recoveryDoor`,
  threaded by `useCreateAccount`);
- all three steps open with a **`StepHeader`** — a chrome row (the Back link plus a
  plain **"Step _n_ of 3"**) over **that step's own title and description**, at the
  page step (`text-xl font-semibold tracking-tight`). The heading is the STEP's,
  not the page's: "Create account" / _no email, no password reset_ → "Confirm your
  password" / _re-enter it…_ → "Recovery code" / _the only way back in…_. A static
  "Create account" above a screen whose only job is to re-enter a password spends
  the loudest slot on a message the user already acted on, and leaves two
  near-identical screens differing only by a small grey counter — swapping the
  title is the change a user actually notices. Steps 2 and 3 already carried those
  exact strings one text step down (as a `FieldLabel` + `FieldDescription`), so
  this **promotes** copy rather than adding any;
- consequently **neither the page nor the screen renders a header of its own** —
  `bracemark-web`'s `(auth)/create-account/page.tsx` has no `CardHeader` and
  `bracemark-expo`'s `(auth)/create-account/index.tsx` passes `AuthScreen` no
  `title` (its `title`/`description` are optional for exactly this). `step` is
  form-local state, three boundaries below both, so the header moved down to the
  state rather than the state being lifted up to the header. The **consent line**
  does _not_ move: it must hold at every step, so it must not be step-aware. On the
  confirm step the promoted title is a heading, not a `<label>` — the input keeps an
  `sr-only` `<label htmlFor>` on web and an `aria-label` on native;
- the counter stays plain text. It earns its place on step **one**, where it's the
  only thing that tells the user a recovery code is coming. By the recovery step it
  reads as "one screen left", which is the number that competes with that step's
  recovery-less exit — so it deliberately does **not** say "(optional)" there, even
  though the step is. Not dots, a progress bar, or a coloured capsule strip: dots
  imply steps you can click back to, and an accented indicator would outshout the
  primary button on the one screen where it races a second submit. With the title
  changing per step, the counter is left the smaller job of saying how much is
  left. Mirrored in `bracemark-expo`'s `features/auth/create-account-form.tsx`;
- the recovery step offers **two ways to create the account**, and the second is
  labelled by its outcome — **"Create account without a recovery code"**, a
  full-width `ghost` button under the primary. It is not a "skip": `submit(false)`
  performs the same irreversible act, minus the door. The earlier wording ("Skip
  for now — I'll set this up later") as an underlined text link named neither, and
  since the primary is disabled until the checkbox is ticked, the only **live**
  control on arrival was one that read as leaving without an account. Ghost rather
  than `outline`/`secondary` because the primary sits at 50% opacity in that same
  arrival state, so a bordered or filled alternative would be the strongest thing
  on screen precisely where the recommended path should lead — and rather than a
  text link because it is a submit, and needs a submit's hit target (the native
  twin's was under Apple's 44pt floor). Mandatory is **not** the alternative:
  `recoverySaved` is an attestation, not proof, so forcing it only moves the exit
  into the checkbox, and an account whose owner ticked a box without saving the
  code is worse off than one that knowingly has no second door.

This keeps the promise: a user _can_ pick their own username and password (good
UX), but the **safe path is the default path** (wallet-grade entropy), rather
than relying on every user to invent a strong secret.

### sign-in with a recovery code

> **STATUS — ✅ built.** The escape hatch when the password is lost.

Sign-in offers a **"Use a recovery code"** path (`sign-in-form.tsx`,
`useSignInWithRecovery`): the client fetches the recovery door pre-auth (GET
`/v1/auth/recovery-door`, the twin of the password-door fetch — 404s when the
account skipped recovery), HKDFs the recovery-KEK over the normalized code,
unwraps the **same DEK**, and derives the **same keypair** — so the resulting
session is indistinguishable from a password sign-in (same `action: 'sign-in'`
proof, same `publicKey`). Because the reason to be here is a forgotten password,
the intended follow-up is to set a new one (change-password accepts the recovery
opener). _Nice-to-have not yet wired: forcing that set-new-password step
immediately after a recovery sign-in; today the user does it from Settings._

### when a submit is allowed to be `disabled`

The rule across every credential surface — the two auth forms and Settings →
Account alike: **disable only when something else on screen already says why,
permanently and adjacently.** A disabled button is silent in every channel —
`disabled` drops it from the tab order, `disabled:pointer-events-none` kills
hover, and nothing is announced — so it is only honest when the blocker is either
a **permanent message line** under the offending field (the setup step, where the
ladder _is_ the gate) or a **labelled checkbox** immediately above it
(`passphraseSaved`, `recoverySaved` — both `ShowOnceSecret`). Everything
else stays live and answers the click with an announced error, which is the one
channel a disabled button doesn't have
([accessibility.md](./accessibility.md), _the one rule_). Qualifying is a
permission, not an obligation: delete-account's confirm box would satisfy this
rule and deliberately doesn't take it (below).

An in-flight request is the third allowed case, and there the **label** carries
the state ("Signing in…", "Deleting account…") — the greyed rectangle announces
nothing by itself.

So: the confirm step's Continue is always live (gating it on a live match would
make the button a hint oracle for the password being re-typed); password sign-in
submits empty and lets validation speak — its fields are RHF-uncontrolled, so an
emptiness gate read through `watch` can also go stale against a password-manager
fill; and **no submit disables on an empty required field any more**. Five did,
each with nothing on screen explaining it — recovery sign-in, delete-account's
password, change-password's proof field, the recovery-code mint's password, and
their expo twins. They now submit and answer in the slot that field's other errors
already use. Delete-account reports the empty password and the unticked box in the
same pass, so satisfying one doesn't reveal the other — and that is precisely why
its confirm box, legible enough to gate on, does **not** hold the button down. A
checkbox gate can only ever report the miss it is gating on, so a user who typed a
password but didn't tick would meet a dead button naming neither requirement, and
wouldn't hear about the password until after ticking. `ShowOnceSecret`'s two boxes
have neither problem: each is the only requirement on its step, and each attests
to an act performed off-screen ("I've saved it") that the disable exists to teach.
Create-account's disabled primary also sits above a **live** ghost alternative,
where delete-account's button is the whole screen's only control. The one
emptiness gate that _stays_ is delete-account's `subscriptionBlocks`, which has a
`SettingsNotice` above it stating the block in full and linking where to fix it.

Recovery sign-in was the worst of the five and got the deepest fix: it hand-rolled
two `useState` fields plus a `string | null` error, which is how it drifted from
its password twin in the first place. It now runs the same react-hook-form setup
over a shared **`recoverySignInSchema`** (`useRecoverySignInForm` in
`@stxapps/react`), so it has per-field errors and a submit-level `root` like the
password path. The `recoveryCodeSchema` inside it is deliberately as permissive as
`passwordSchema`: it checks only that something survives `normalizeRecoveryCode`,
with **no length equality against the canonical 52 chars**. This is the door you
reach for when the password is already gone, the GCM tag is a free exact check
seconds later, and a format rule is the kind of thing that outlives the format.

### the two identifiers

A common source of confusion: an account has **one identifier and one
credential**, not "two ids."

| name        | what it is                                                                                                                       | derived/stored where                                             | sent to server?        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| `userId`    | the account's **stable primary key** — random, server-minted (`newId()`); also the Durable Object address (`idFromName(userId)`) | bracemark-api `users` table                                      | issued _by_ the server |
| `publicKey` | the **credential** — Ed25519 public key the server verifies signatures against                                                   | derived on the client from the DEK; stored as `users.public_key` | yes (it's public)      |

Why keep a separate random `userId` instead of using the `publicKey` as the id:

- **stability / addressing** — a stable `userId` is the immutable DO address and
  foreign-key target. With the DEK model the `publicKey` is now **stable across
  password changes** (a password change only re-wraps the DEK; the DEK-derived
  keypair is unchanged) and changes _only_ on the rare DEK rotation — but
  `userId` stays the one value safe to denormalize (e.g. into `sessions`) and
  reference everywhere. `public_key` is **not denormalized into `sessions`**:
  `user_id` is immutable and read on every request; `public_key` is read only at
  sign-in.
- **no credential leakage** — a separate id keeps the public key in exactly one
  place rather than sprinkled across sessions, op-logs, and every reference.

**One credential, many doors — and why that's not a contradiction.** There are
now several doors, but they are about **decryption** (unwrapping the DEK), not
**authentication**. The server still verifies exactly one thing: a signature
from the DEK-derived `publicKey`. So `publicKey` stays a single **column** on
`users`, not a 1:N `credentials` table — the multiplicity lives in the
`account_keys` table (one wrapped-DEK row per door), not in server credentials.
A passkey or
recovery code unwraps the DEK, after which the client derives the same keypair
and authenticates with it; no door is its own server credential.

So: identify by `userId` (and the human-facing `username`), **authenticate** by
a signature the `publicKey` verifies. The client proves ownership by signing a
timestamped `{ publicKey, username, action, timestamp }` payload with the
Ed25519 private key at create-account / sign-in.

> **The load-bearing sign-in check.** The server **cannot** verify that a
> keypair was honestly derived — a client can sign a valid payload with _any_
> keypair and _any_ username. That is fine, but only if the server, on sign-in,
> checks the presented `publicKey` against the **stored** `users.public_key` for
> that username — not merely that the signature is internally valid. The flow:
> (1) client sends username → server returns the **password-door** wrapped blob;
> (2) client unwraps the DEK with `Argon2id(password, salt)` (a wrong password
> fails on the GCM tag), derives the keypair, and signs; (3) server verifies the
> signature against `payload.publicKey`, confirms
> `payload.publicKey === users.public_key` for the username, and checks `action`
>
> - a fresh `timestamp`. Skipping the comparison in step 3 would let anyone
>   "sign in" with their own key. On create-account there is no stored key yet, so
>   that comparison is replaced by the `username` UNIQUE check, the presented
>   `publicKey` is stored, and the door blobs are stored alongside it.

> **Replay window — accepted.** The proof is bound to its `action` and a fresh
> `timestamp` (±5 minutes, `TIMESTAMP_WINDOW_MS` in `lib/auth-proof.ts`), but
> there is **no server-issued nonce**: within that window, anyone holding a
> captured signed payload can replay it to mint additional sessions. TLS makes
> capture the hard part — which also means a sign-in **request body is as good
> as a bearer token** to whoever can read it, so request bodies must never be
> logged on the auth paths. A replayed create-account proof is harmless (the
> directory claim 409s); a replayed sign-in proof mints a session for the
> attacker, the same prize as a stolen session token, with the same 30-day TTL.
> We accept this: the exposure window is minutes, the capture vector (TLS
> interception, body logging) already yields live bearer tokens anyway, and a
> nonce costs an extra round trip on every sign-in. **Upgrade path, if replay
> ever needs to be closed completely:** (a) a server-issued **single-use
> challenge** — client fetches it (e.g. alongside the password-door blob),
> echoes it in the signed payload, server consumes it on verify; or (b) cheaper,
> a **single-use signature cache** — reject any signature already seen within
> the timestamp window (a small TTL'd KV/DO set; the window bounds its size).
> Both are payload/endpoint changes only — the frozen derivation contract
> (`crypto/params.ts`) and the DEK/door model are untouched.

> **STATUS — built:** create-account and sign-in are both wired end-to-end. The
> DEK indirection, wrapped-blob storage, and the `users.public_key` column exist
> (`services/account.ts`); the client derives `publicKey` and signs at both
> create-account (`use-create-account.ts`) and sign-in (`use-sign-in.ts`). The
> three-step sign-in check above is implemented: GET `/v1/auth/password-door`
> serves the blob (step 1), `unlockAccount` unwraps + signs client-side (step 2),
> and POST `/v1/auth/sign-in` runs `verifyAuthProof` then `signIn`, which compares
> `payload.publicKey === users.public_key` (step 3). Still open: the
> **orphan-claim sweeper**. (Username existence is observable **by design** —
> `GET /v1/auth/username-available` requires it for signup — so the pre-auth blob
> fetch is rate-limited but deliberately not existence-masked; that's an accepted
> property, not a gap. See [why the wrapped DEK is served
> pre-auth](#why-the-wrapped-dek-is-served-pre-auth--the-offline-attack-surface).)

### why the wrapped DEK is served pre-auth — the offline-attack surface

Step 1 of the sign-in check hands the **password-door `wrapped_dek` to anyone who
names a username**, before any authentication. It has to: the client can't derive
anything until it has the blob. So the blob is an **offline brute-force oracle** —
an attacker fetches it once, then locally runs `Argon2id(guess, salt)` → try to
AEAD-unwrap → the GCM tag confirms a hit, with **no server round-trip and so no
rate-limit**. This is the same exposure direct derivation had (the `publicKey`
was the oracle then); the DEK model neither adds nor removes it.

**The defense is entropy, not secrecy of the blob.** Like a wallet, the
derivation is semi-public and the entropy is the wall: against a 7-word generated
passphrase (~77 bits) the freely-served blob is not a practical risk, while
`Summer2026!` falls regardless of how the blob is served. This is why the open
items lead with the **entropy gate + generated passphrase** rather than gating
the blob — that is the load-bearing mitigation.

**Could we gate the blob behind a proof instead?** Requiring the client to prove
knowledge of a password-derived secret before the server releases the blob would
convert the _offline_ attack into an _online_, rate-limitable one. Two limits
make this a poor trade _today_:

- A naive "store a KEK public key, require a challenge signature" only helps if
  that verifier is **never served pre-auth** (otherwise it's just another offline
  oracle), and it still **does not survive a DB breach**: the verifier sits in the
  same row as the `wrapped_dek`, so a dump yields the blob and it's offline-
  attackable anyway. Gating defends only the _pre-auth-fetch_ vector — a random
  external scraper — and mostly only when the password is weak, which is exactly
  what the entropy gate removes. It overlaps heavily with "require strong
  passwords" while adding frozen-contract surface.
- The _correct_ strong form is a **PAKE — specifically OPAQUE** (asymmetric PAKE).
  Its `export_key` output is designed precisely to encrypt a client-side secret
  like our DEK, and because a server-held OPRF key participates in deriving the
  KEK, the blob alone is useless without online interaction (and the OPRF key can
  live in a KMS so a DB-only breach stays safe). That is genuinely "best" for the
  password door — at the cost of real complexity, scarce audited Workers
  implementations, and a frozen-contract commitment.

**The DEK indirection keeps OPAQUE a future, isolated swap.** Each door wraps the
same DEK independently, so the password door could later become OPAQUE (use its
`export_key` as that door's KEK) **without touching the DEK, the data, or the
recovery/passkey doors**. High-entropy doors (recovery code, passkey-PRF) never
need a PAKE — offline-attacking a 256-bit secret is infeasible — so a hybrid
(password = OPAQUE, others = plain KEK-wrap) composes cleanly with the model.

**Decision (pre-launch):** keep the blob served pre-auth; lean on the entropy
gate + generated passphrase as the real defense; add cheap **rate-limiting** on the
blob-fetch path to blunt mass-scraping. Username existence stays observable **by
design** — `GET /v1/auth/username-available` requires it for signup, so masking the
blob fetch in isolation would buy nothing; it is rate-limited, not existence-masked.
Treat OPAQUE as the documented upgrade path for the password door, adopted only
if online-only (or KMS-isolated breach-resistant) password protection becomes a
requirement; skip the naive KEK-signature half-measure.

> ⚠ **This section is published.** `bracemark-site`'s `/security` page states the
> pre-auth blob and the offline attack on it in plain language — that a weak
> password can be guessed at locally, with no round-trip to rate-limit — because
> volunteering a residual a reader could derive from an AGPL repository is the
> move the rest of the property is built on. Two consequences. The **decision**
> above is now a public disclosure as well as an internal one, so revisiting it
> (adopting OPAQUE for the password door, or gating the blob) means editing that
> page in the same change; the page describes the build, not an eternal. And the
> **argument** there rests entirely on the entropy gate — it says Argon2id buys
> time and only entropy buys safety — so weakening the generated-passphrase
> default, or letting a low-entropy password through, falsifies a public page as
> well as a design decision. The `ARGON2_PARAMS` numbers on that page are
> _imported_ from `crypto/params.ts`, so those cannot drift silently the way
> /extractor's hand-written caps can ([hosting.md](./hosting.md), `/security`);
> the prose around them can.

### storage durability — the most critical state in the system

The DEK model introduces a hard new dependency that direct derivation did not
have. Spell it out, because the failure is fatal and silent:

> **The wrapped-DEK blobs and the `users` table are Tier-0, irreplaceable
> state. If they are lost, the account is dead — permanently, with correct
> credentials.** The DEK is _random_; nothing can recompute it. Lose every
> wrapped copy and all doors are gone, so the encrypted bookmarks — which still
> sit safely in storage — can never be decrypted again. This is strictly worse
> than the old direct-derivation model, where `(username, password)` alone
> regenerated the keys from nothing. Recovery doors do **not** save you here: a
> recovery code is a _KEK_, not a copy of the DEK, so it only defends against
> _forgetting the password_ — never against _us losing the blob_. Different
> failure mode, no overlap.

The `users` row is equally load-bearing: it is the auth credential
(`public_key`) and the uniqueness namespace (`username`). Losing it loses
sign-in and orphans the data.

So this Tier-0 state — the `users` row **and** its wrapped DEKs — lives in **D1**
(`account_keys` inline with `users`, in the same shard, so they commit together).
The `usernames` directory is also Tier-0 (it's the only path from a handle to an
account) but lives in its own D1; the two are backed up as one set. Only the
**bulk encrypted bookmarks** (large, and already mirrored by the client's
local-first copy) go to R2.

> **Tradeoff taken (greenfield):** splitting the directory into its own D1 means
> the Tier-0 set spans **multiple** D1 databases with **separate** PITR timelines,
> and create-account is **claim-then-write**, not one transaction (the three steps
> in the schema section above). We
> accept this now to never hit the 10 GB cap and to make adding a shard a
> no-code-change, no-migration event. `users`↔`account_keys` atomicity and
> username uniqueness are both preserved; only the claim↔account link is
> non-transactional (orphan = a reclaimable directory row).

#### the split: D1 for the account + keys, R2 for bulk ciphertext

| store                 | holds                                                                       | why                                               |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| **D1** (SQLite)       | `usernames` (directory) · `users` + `account_keys` (per shard) · `sessions` | relational, `UNIQUE` username, per-db Time Travel |
| **R2** (object store) | the bulk encrypted bookmark blobs                                           | large, cheap, no egress; not key material         |

A wrapped DEK is ~80 bytes (32-byte DEK + IV + GCM tag), so it lives **inline in
D1**, in the same row as its index — not in R2. R2 has no native object
versioning and would force a second store with no shared transaction; D1 keeps
the keys atomic with the credential and gives them free 30-day PITR. Reserve R2
for what it's actually best at — the large bookmark ciphertext — which the
client also holds locally, so an R2 loss degrades to a re-sync, not a death.

Concrete D1 schema, across **three databases** (split now, while greenfield —
see [the sharding seam](#future-sharding-d1--the-seam-is-pre-cut)). The username
is held in its own **`DIRECTORY_DB`** (the global uniqueness namespace, never
sharded), the account rows in account **shards** (`ACCOUNTS_DB_1`, …), and
sessions in **`SESSIONS_DB`** (high-churn, not Tier-0). Mirrored in
`apps/bracemark-api/src/db/schemas/{directory,accounts,sessions}.sql`.

```sql
-- DIRECTORY_DB --------------------------------------------------------------

-- the global uniqueness namespace + username→shard map. PK = the UNIQUE check;
-- the claim is a single `INSERT ... ON CONFLICT DO NOTHING` (race-free).
-- account_db_id is the EXPLICIT shard holding this user's rows (e.g. '1'),
-- assigned at create-account (assignAccountDbId) and resolved by db-routes. NOT
-- NULL — every row self-describes its shard, so adding a shard never rewrites
-- existing rows (they keep their stored id).
CREATE TABLE usernames (
  username      TEXT PRIMARY KEY,        -- canonical (trim→NFKC→lowercase)
  user_id       TEXT NOT NULL,
  account_db_id TEXT NOT NULL,           -- e.g. '1' ⇒ ACCOUNTS_DB_1
  created_at    INTEGER NOT NULL,        -- when the name was claimed
  deleted_at    INTEGER                  -- non-NULL = tombstone (account deleted, name stays occupied)
);
CREATE INDEX idx_usernames_user_id ON usernames(user_id);

-- ACCOUNTS_DB_N (one per shard) ---------------------------------------------

CREATE TABLE users (
  id         TEXT PRIMARY KEY,           -- random, server-minted (newId())
  public_key TEXT NOT NULL UNIQUE,       -- ed25519 hex — the credential
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- one row per door; the wrapped DEK lives inline. Stays in the SAME shard as
-- `users` so credential + key commit together in one batch.
CREATE TABLE account_keys (
  user_id     TEXT NOT NULL REFERENCES users(id),
  door_type   TEXT NOT NULL,             -- 'password' | 'recovery' | 'passkey'
  wrapped_dek BLOB NOT NULL,             -- AES-256-GCM(KEK, DEK), aad = doorType
  iv          BLOB NOT NULL,             -- GCM nonce for this wrap
  version     INTEGER NOT NULL,          -- bumped on each re-wrap (audit/debug)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, door_type)
);

-- SESSIONS_DB ---------------------------------------------------------------

-- bearer-token sessions. account_db_id denormalized so the auth guard routes
-- "token → user → accounts shard" in one read. No FK (different db); not Tier-0.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL,
  account_db_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

**Create-account is cross-DB (claim-then-write).** Because the directory and the
account rows live in different databases, there is no single transaction:

1. **Claim** the username in `DIRECTORY_DB` (`INSERT … ON CONFLICT DO NOTHING`) —
   the authoritative, race-free uniqueness gate; a lost race is a clean 409.
2. **Write** `users` + every `account_keys` door in the shard, in one atomic
   `db.batch` (all-or-nothing within the shard).
3. **Compensate**: if step 2 fails, **release** the claim so the name isn't
   orphaned (best-effort; a sweeper backstops it).

Uniqueness is always enforced and `users`↔`account_keys` stay atomic; only the
claim↔account link is non-transactional, and its worst case is a reclaimable
orphan username — never data loss or a uniqueness violation. Claim-then-write
(not write-then-claim) so a routine taken-username fails fast at step 1 before any
shard write, and the only possible orphan is a tiny directory row, not an
unreachable account carrying wrapped DEKs.

#### the rules

1. **Account write is one transaction; the username claim is a compensated
   step.** Create-account writes the `users` row and its `account_keys` rows in a
   **single shard transaction** (`db.batch`) — no ordering to get wrong within the
   account. The `usernames` claim is in a different db, so it's the one
   cross-store step: claim first, then write, then release on failure (the orphan
   is a reclaimable directory row — never a half-written account). The bulk
   ciphertext goes to R2 separately, but it is _not_ key material: a missing bulk
   blob is recoverable from the client's local copy, so it isn't Tier-0.
2. **Re-wrap is one atomic UPDATE.** A password change re-derives the
   password-KEK and `UPDATE`s that door's `wrapped_dek` / `iv` / `version` in
   place, atomically. Time Travel is the safety net if a bad write slips through
   — no manual versioned-blob dance needed (that complexity only existed to
   paper over R2's lack of versioning).
3. **Revoke = delete the door's row**, deliberately (plus its `sessions` row).
   The DEK is unchanged, so the other doors keep working — no re-encryption.
4. **Bulk R2 hygiene.** Keep the bookmark bucket free of any lifecycle rule that
   could silently expire a user's server copy; route deletes through a separate
   admin path, not the hot request path.

#### backups & replication (set up before launch)

- **D1 Tier-0 set — `DIRECTORY_DB` (`usernames`) + every account shard (`users` +
  `account_keys` / wrapped DEKs):** Time Travel is always on and free — any point
  in the **last 30 days** is restorable (`wrangler d1 time-travel restore`). Note
  these are now **separate databases with separate timelines**, so a
  point-in-time restore that must stay consistent across the directory and a shard
  is a per-db operation — pick a quiet point and restore each. For retention
  beyond 30 days, run a **scheduled D1 export** (REST API + Workflows / a
  Cron-triggered Worker) daily for **each** of these dbs, and copy at least the
  weekly dump **off Cloudflare** (e.g. to S3) so a platform-level account problem
  can't take the Tier-0 state with it. (`SESSIONS_DB` is not Tier-0 — skip it.)
- **R2 (bulk ciphertext):** R2 is durable but **not versioned**. This data is
  lower-stakes (the client's local-first copy is a second replica), but still
  guard against accidental delete/overwrite with **R2 event notifications →
  Queue → Worker** replicating writes to a second bucket.
- **Test restores.** A backup you have never restored is not a backup —
  periodically restore D1 to a scratch DB and confirm a sample of wrapped DEKs
  still unwrap.

#### why not the per-user Durable Object?

We already run a Durable Object per user (`idFromName(userId)`), so it's natural
to ask why the keys don't live there. **Backup is no longer the reason not to** —
SQLite-backed DOs now have **30-day point-in-time recovery, on by default**
(only the legacy KV-backed DOs lack it). The reasons are structural:

1. **You can't reach the DO without D1 first.** The DO is addressed by `userId`,
   but sign-in presents a **username**. The username→userId resolution and the
   global `UNIQUE(username)` constraint can only live in a global store (D1) — a
   per-user DO can't enforce global uniqueness. So D1 is unavoidable regardless;
   the only question is whether the keys join it there.
2. **Keys-in-DO recreates the two-store hazard.** `users` in D1 + wrapped DEK in
   the DO is the same split-brain (ordering, orphans, reconciliation) as
   D1↔R2 — just relocated. Inline in D1 collapses it to one transaction.
3. **The password-door blob is read _pre-auth_.** Serving it from D1 is a cheap
   indexed read; serving it from the DO wakes the user's object on every sign-in
   attempt — including attacker username-probes — adding latency and a
   force-instantiation DoS surface.
4. **One restore timeline, not N.** D1 PITR restores the credential and its keys
   together with one command; DO PITR is per-object, so a _consistent_ restore
   across the registry plus every affected DO is far harder.

The DO's real job is the user's **bookmark data / sync / op-log** (strong
per-user consistency, now PITR-backed). Keep that there; keep the tiny, pre-auth,
Tier-0 wrapped DEK beside its credential in D1.

#### future: sharding D1 — the seam is pre-cut

A single 10 GB D1 holds **millions** of accounts (≈1 KB each — `users` +
`account_keys`), so actually needing a second shard is years away or never. But
because this is greenfield, the **sharded topology is already in place** (cheapest
it'll ever be) so capacity is never a worry and adding a shard migrates nobody:

- the **`usernames` directory** is its own database, `DIRECTORY_DB` — the global
  uniqueness namespace, never sharded (and ~140M usernames fit in one 10 GB db,
  ~20× the per-shard account capacity);
- the account rows live in shards: `ACCOUNTS_DB_1` today, `ACCOUNTS_DB_2`, … later
  (`users` + `account_keys` always together in one shard);
- every directory/session row carries an explicit **`account_db_id`** (NOT NULL,
  e.g. `'1'`), assigned by `assignAccountDbId()` at create-account — so each row
  self-describes its shard and existing rows are never rewritten when one is added;
- **`db/db-routes.ts`** (`accountsDb(env, accountDbId)`) resolves the id → shard
  binding by **reading** the stored id, never hashing the userId — so a user
  never moves once assigned;
- **sessions** live in their own `SESSIONS_DB`;
- **create-account already pays the cross-DB cost** (claim-then-write +
  compensate; see above) — so adding a shard later changes no code path, only
  data: provision `ACCOUNTS_DB_2`, add its binding + a `case '2'` in
  `db-routes.ts`, and return `'2'` from `assignAccountDbId()`. Existing rows keep
  their stored `'1'`, untouched.

What makes this work — and shard-later trivial — is the access shape, not luck:

- **Shard key = `userId`.** It's random (`newId()`) and uniform, and _every_
  access is "by this user" → a single shard. Routing is a pure function of the
  key, never a scan.
- **Bounded rows per user** (1 in `users`, ≤3 in `account_keys`) means no single
  user can overflow a shard, distribution stays even, and migrating to shards
  later is an **online, user-by-user** move (read a user's handful of rows,
  write them to the target shard, update the directory). This holds _only_
  because per-user-unbounded data (bookmarks) lives in R2 / the per-user DO —
  **never put unbounded per-user data in D1**, or this property breaks.

The one genuinely cross-shard concern is the global **`UNIQUE(username)`**
constraint: usernames can't be unique across shards keyed by `userId`. Solve it
with a tiny global **directory** table — `username → (userId, shardId)` — which
sign-in hits first (it arrives with a username, not a userId) to both resolve
the shard and enforce uniqueness. At ~70 B/row that directory holds **~100M+
usernames in one 10 GB db**, so the unshardable part outscales the sharded part
by an order of magnitude. (Algorithmic `hash(userId) % N` routing avoids a
directory but makes changing `N` a rehash/move; the directory costs one hop but
allows moving individual users and uneven shards.)

Two things to **avoid**, as they would make sharding hard:

- **Sequential / fan-out search** ("try db1, then db2…") — O(N) per lookup and it
  breaks uniqueness ("first match wins" lets two shards both claim a username).
  Always route deterministically via the directory or hash.
- **Cross-user JOINs in D1** (global feeds, social graphs, "search all users") —
  these become cross-shard scatter-gather. Everything today is per-user; keep it
  that way.

#### client-side resilience (defense in depth, not a substitute)

- An active client caches the **unwrapped DEK** locally (IndexedDB, as a
  non-extractable `CryptoKey`), so a transient server hiccup never locks a live
  session. A _fresh_ device still depends entirely on server durability — which
  is why the D1 backup discipline above is non-negotiable.
- Optionally let the user **download their wrapped-DEK blob** as an explicit
  user-held backup file — a last-ditch copy that survives even total server loss
  (still useless without a door's secret).

> Cloudflare references: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
> [D1 export](https://developers.cloudflare.com/d1/wrangler-commands/),
> [D1 limits (10 GB/db, 50k dbs)](https://developers.cloudflare.com/d1/platform/limits/),
> [SQLite-backed DO storage + PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
> R2 has **no** native object versioning as of 2026-06; keys live in D1 for that
> reason, and bulk R2 data is replicated rather than versioned.

### rollout — adopt the architecture now, ship doors later

The architecture is the decision; the doors are incremental. Doing the DEK
indirection **before real users exist** is the whole point — afterwards, adding
it is a re-key migration of every account.

- **Phase 0 — ✅ done.** The root is a random DEK with a **single password door**.
  UX is identical to direct derivation, but every later door is additive (wrap
  another copy of the DEK), not a migration.
- **Phase 1 — ✅ done (web).** The generated **recovery code** is a second door
  (skippable at create, add/replace in Settings), plus the generated-passphrase
  ceremony, the zxcvbn gate, recovery sign-in, and change-password / recovery-code
  door management. Expo parity is the remaining slice of this phase.
- **Phase 2 — later.** Add the **passkey (PRF)** door where supported — the
  platform-synced, per-device door that actually survives.
- **Also later.** **DEK rotation** (the compromise remedy — see the rotation
  section) and **expo-crypto / expo-react parity** of the door API + hooks (the
  `shared` generators already work on both, pinned by the golden vectors).

Messaging shifts from "don't lose your password" to **"lose _all_ your doors and
the data is gone."**

### open items before launch

- **DEK indirection (Phase 0)** — adopt the random-DEK root + password door
  _before_ the first real user; it's free now and a migration later.
- **`APP_SALT`** — ✅ set to a real 256-bit high-entropy constant
  (`crypto/params.ts`, `bracemark.app-salt.v1.…`). It can never change after the
  first real user; a hypothetical rotation mints a `.v2.` constant rather than
  editing it.
- **Entropy gate** — ✅ built (zxcvbn `guessesLog10 >= PASSWORD_MIN_GUESSES_LOG10`
  on the typed path — **never** the 0–4 `score`, see above — over both language
  packs, plus the meter + hard length floor described above).
- **Generated passphrase** — ✅ built (the "Secure your account" ceremony +
  skippable recovery code + recovery sign-in + change-password/recovery door
  management). Remaining: **DEK rotation** (compromise remedy) and **expo parity**.
- **No-recovery messaging** — ✅ built: the create-account UI states "there is no
  reset" and the skippable recovery step; a persistent "no recovery set" nudge
  lives in Settings → Account.
- **Server credential + key storage and signature verification** — **✅ built**.
  Storage: `createAccount` claims the username in `DIRECTORY_DB`, writes
  `users.public_key` + `account_keys` (wrapped DEK inline) atomically in the shard,
  and releases the claim on failure. The **create-account contract** (POST
  `/v1/auth/create-account`) and the **load-bearing sign-in check** (GET
  `/v1/auth/password-door` → `unlockAccount` client-side → POST `/v1/auth/sign-in`,
  which verifies the signature then matches `payload.publicKey` against the stored
  key — see [the two identifiers](#the-two-identifiers)) are both wired
  (`services/account.ts`, `routes/auth.ts`). Still open: the **orphan-claim
  sweeper** (reclaim claims with no backing `users` row, alongside
  `sessions.deleteExpired`).
- **CSP on bracemark-web** — the bearer token and the (non-extractable) encryption
  key live in IndexedDB, readable by any JS on the origin (see the SECURITY note
  in `data/session-store.ts`); a strong CSP is the real mitigation — chiefly
  `connect-src` pinned to self + the api origin, so injected script can't
  exfiltrate what it reads. bracemark-web is a static export, so the header is
  attached by the per-tier **CloudFront response headers policy**, not
  `next.config` — see [hosting.md](./hosting.md#security-headers--where-the-csp-has-to-live) for the policy details
  and CSP gotchas (`'wasm-unsafe-eval'` for Argon2, no nonces on static export,
  `worker-src`). Not yet built; ship it with the first deploy.
- **OPAQUE password door (future, optional)** — the documented upgrade path if
  online-only (or KMS-isolated breach-resistant) password protection becomes a
  requirement; swap the password door's KEK for OPAQUE's `export_key` in isolation
  — no DEK/data/other-door change. Skip the naive KEK-signature half-measure.
- **Storage durability** — schema/topology is **✅ built**: three databases
  (`DIRECTORY_DB`, `ACCOUNTS_DB_1`, `SESSIONS_DB`), `account_keys` with the
  **wrapped DEK inline** in the shard, and the `account_db_id` routing seam. Still
  open (don't wait for the first real user): the daily export + off-platform copy
  for `DIRECTORY_DB` **and** each account shard (the two together are the Tier-0
  set), and a restore drill.
