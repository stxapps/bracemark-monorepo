import Link from 'next/link';

import {
  entitlementsOf,
  LIFETIME_ON_SALE,
  LIFETIME_PLAN,
  LIFETIME_SEATS,
  LIFETIME_USD,
  LINK_NOTE_MAX,
  PLAN_LABELS,
  PLAN_USD_PER_YEAR,
  TRIAL_DAYS,
} from '@stxapps/shared';

import { SECURITY_EMAIL, SOURCE, SUPPORT_EMAIL } from '../lib/site';

// The site's questions and answers, in ONE place, because two surfaces render
// them: /faq shows every group, and /pricing shows the four billing questions a
// buyer asks with a card in their hand (`PRICING_FAQ_IDS` below). Written twice
// they would answer differently within a release or two — the trial length in one
// place, the refund position in the other.
//
// Every number is read from `@stxapps/shared`, never typed. Same rule as the
// pricing page: an FAQ that quotes a cap the app doesn't enforce is worse than no
// FAQ, because a visitor believes it.
//
// The answers are `ReactNode` rather than strings so a few of them can link out —
// which is why this file is `.tsx` and lives in `content/` rather than `lib/`.

const FREE_LINKS = entitlementsOf('free').maxLinks;

export type FaqItem = { id: string; q: string; a: React.ReactNode };
export type FaqGroup = { id: string; title: string; blurb: string; items: FaqItem[] };

function MailLink({ address }: { address: string }) {
  return (
    <a
      className="rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal"
      href={`mailto:${address}`}
    >
      {address}
    </a>
  );
}

// The off-origin sibling of PageLink — a plain <a>, since next/link has no route
// to prefetch on another host.
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal"
      href={href}
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

function PageLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      className="rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal"
      href={href}
    >
      {children}
    </Link>
  );
}

export const FAQ_GROUPS: FaqGroup[] = [
  {
    id: 'general',
    title: 'The basics',
    blurb: 'What Bracemark is, and where it runs.',
    items: [
      {
        id: 'what-is-it',
        q: 'What is Bracemark?',
        a: (
          <>
            A place to keep the links you want to come back to — articles, documentation, threads,
            products, videos — available on every device you use. What makes it different from most
            bookmark managers is where the encryption happens: each link is encrypted on your
            device, with a key derived from your password, before any of it syncs. We store the
            result and cannot open it.
          </>
        ),
      },
      {
        id: 'vs-others',
        q: 'How is this different from Raindrop, Pocket or my browser’s bookmarks?',
        a: (
          <>
            Browser bookmarks don’t follow you off that browser. The hosted managers do follow you,
            but their servers hold your titles and addresses in readable form — that is what makes
            their server-side search and recommendations possible in the first place. Bracemark
            gives up those server-side features in exchange for a server that has nothing to read.
            Search, previews and organisation all happen on your own devices instead.
          </>
        ),
      },
      {
        id: 'platforms',
        q: 'Where does it run?',
        a: (
          <>
            A web app in any modern browser — Chrome, Firefox, Safari, Edge — on desktops, tablets
            and phones; native apps for iOS and Android; and a browser extension for Chrome and
            Firefox. One account, the same library everywhere.
          </>
        ),
      },
      {
        // The last sentence is the one that matters, and it is here because
        // "opens, browses and searches" was read as offline READING by everyone
        // arriving from a read-it-later app — the answer was accurate and the
        // inference it invited was wrong, which is the worst kind of copy.
        //
        // It now states what IS on the device, and what following a link out
        // costs, rather than "and not the pages themselves". That negative was a
        // promise about features that are PLANNED rather than declined — read
        // mode, screenshot and page copy (docs/link-extraction.md, _capability
        // tiers_) — and it was standing in four places at once; the landing
        // hero, the /about trade-offs and /terms shed it in the same change. The
        // inventory is the half that was doing the work anyway: a reader who
        // wants the article itself offline can see it is not in the list.
        id: 'offline',
        q: 'Does it work offline?',
        a: (
          <>
            Yes. Bracemark is local-first: the app reads from a copy of your library held on the
            device, so it opens, browses and searches with no connection at all. Anything you change
            while offline is queued and syncs the next time you have a network. What is on the
            device is your library — addresses, titles, tags, notes and preview images. Following a
            link out to the live page is the one thing that still needs a connection.
          </>
        ),
      },
      {
        id: 'need-extension',
        q: 'Do I have to install the browser extension?',
        a: (
          <>
            No. On a laptop it is the best way to save: the extension reads the page you are already
            looking at, so the title and preview image come from your own browser and nothing has to
            fetch that page on your behalf. On a phone or tablet, share into the iOS or Android app
            from whatever app you are in — the link is saved on the spot, and the app fetches the
            page itself, on the device, the next time you open it. Saving from the web app works
            without either — see the previews question below for what changes.
          </>
        ),
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy and encryption',
    blurb: 'What is encrypted, what we can see, and what we could be made to hand over.',
    items: [
      {
        id: 'e2e',
        q: 'What does “end-to-end encrypted” actually mean here?',
        a: (
          <>
            Your password is put through Argon2id on your device to derive a key, and that key
            unlocks the one your library is encrypted with. Every link, list, tag and setting is its
            own encrypted file; encryption happens before anything is uploaded, and decryption only
            ever happens on a device of yours. The password itself never reaches us — not when you
            sign up, and not when you sign in.
          </>
        ),
      },
      {
        id: 'what-we-see',
        q: 'What can your servers actually see?',
        a: (
          <>
            The username you chose, a public key that lets us check a sign-in signature, and a set
            of encrypted files — each with a path, a size, and the time it last changed. If you
            subscribe, a subscription record too. Not one title, address, tag or note, and no search
            index over any of it. The full inventory is in the{' '}
            <PageLink href="/privacy">privacy policy</PageLink>.
          </>
        ),
      },
      {
        // The follow-up `what-we-see` sets up and doesn't answer: it lists "a
        // subscription record too" and moves on. Payment is the one thing in the
        // product that inherently deanonymizes — the provider needs an identity to
        // charge — so the honest move is to say so in the privacy group rather than
        // let a reader discover it at checkout, having read `no-email` and concluded
        // the account is anonymous end to end. The reassuring half is the true half:
        // it costs anonymity, not confidentiality. Kept minimal on our side on
        // purpose (docs/iap.md, _privacy note_): bracemark-api stores the provider's
        // subscription id against the account and nothing else, which is what makes
        // the last sentence here something the code can back.
        id: 'paying-identity',
        q: 'Doesn’t paying you identify me?',
        a: (
          <>
            It identifies you to the payment provider, yes — it needs a name, an email address and a
            way to charge you, and it holds those under its own privacy policy. What reaches us is
            its identifier for your subscription, stored against your account so the app knows which
            features to unlock. That is the whole of it, and none of it touches the encryption: we
            can tell that an account pays, and still cannot read one link inside it. The free plan
            asks for no card, so it never crosses that line at all.
          </>
        ),
      },
      {
        id: 'trackers',
        q: 'Do you use cookies, trackers or analytics?',
        a: (
          <>
            This website sets no cookies and loads no third-party scripts — even the fonts are
            served from this domain. There is no analytics product, no advertising SDK and no
            fingerprinting in the site or the apps. The one script the app loads from anyone else is
            Paddle’s, and only on one screen: opening Settings → Subscription loads it to look up
            your local price, and it runs the checkout if you go on to subscribe. Paddle sets its
            own cookies to do that. The app does store data in your browser, but it is your library,
            kept there so it works offline.
          </>
        ),
      },
      {
        id: 'compelled',
        q: 'What if someone compels you to hand over my bookmarks?',
        a: (
          <>
            We can only ever hand over what we hold, and what we hold is ciphertext plus the account
            record described above. There is no key on our side to compel, because one was never
            there. That is the point of the design: it removes a decision we would otherwise have to
            be trusted to make.
          </>
        ),
      },
      {
        // The last clause is a THREE-WAY agreement and the flat version of it was
        // wrong on two of the three surfaces. "Stores nothing" is not true of a
        // service whose rate limiter is keyed on `cf-connecting-ip`
        // (apps/bracemark-extractor/src/middleware/rate-limit.ts) — /privacy and
        // /extractor both said so already, and this answer and SECURITY.md both
        // said the flat one. The honest version is not weaker: an IP address that
        // buys a rate limit, named by us, reads better than a "nothing" a reader
        // can disprove by thinking about how rate limiting works. If the limiter's
        // key ever changes, all four surfaces move together.
        id: 'previews',
        q: 'If everything is encrypted, how do link previews work?',
        a: (
          <>
            The device that saves the link does the fetching. The browser extension reads the tab
            you are on; the mobile apps fetch the page themselves. Neither involves us, and both are
            free. The exception is a link saved in the web app, where the browser blocks a page from
            fetching another site — that one needs a server to fetch on your behalf, so it is an
            opt-in {PLAN_LABELS.plus} feature, off until you turn it on. The service that does it
            holds no key, never sees your account, and stores nothing it read — only the IP
            addresses its rate limiter needs to stop one source abusing it.
          </>
        ),
      },
      {
        // Directly before `security-report`, which is the natural next thought for
        // the one person in a hundred who actually opens the repo.
        //
        // THE CLAIM IS DELIBERATELY NARROW (docs/brand-assets.md — _the source_). "Read"
        // and "check what the code does", never "verify what you are running":
        // there is no reproducible build here, so a served bundle cannot be tied
        // back to a commit. The honest limit is stated in the answer rather than
        // left for a reader to work out, which is the same move the /about
        // trade-offs section makes.
        id: 'source',
        q: 'Can I check that the encryption does what you say?',
        a: (
          <>
            Yes — the whole thing is public at{' '}
            <ExternalLink href={SOURCE.url}>{SOURCE.label}</ExternalLink>, under the{' '}
            {SOURCE.license}: the apps, the browser extension, the two servers behind them and the
            key derivation, in one repository. You can read where the key comes from, where
            encryption happens, and what each of those servers is given. One caveat we would rather
            state than have you assume: reading the source proves what the code does, not that the
            bundle your browser downloaded was built from it. That needs reproducible builds, and we
            do not publish them yet.
          </>
        ),
      },
      {
        id: 'security-report',
        q: 'I think I found a security problem.',
        a: (
          <>
            Please tell us before you tell anyone else: <MailLink address={SECURITY_EMAIL} />.
            Include what you did and what happened; you will get a human reply.
          </>
        ),
      },
      {
        // The question `source` creates and does not answer. Whoever opens an AGPL
        // repository containing the sync server asks it within a minute, and until
        // this existed the only answer on the property was one clause on the
        // landing page, inside the durability band — which is the right place for
        // the POSITION and the wrong place for what it would actually take.
        //
        // NAME MORE THAN ONE OBSTACLE. The landing page used to carry a single
        // reason (“our server’s address is compiled in”), which reads as the only
        // one and invites “then make it configurable” — the same shape of error as
        // a privacy claim that names a true subset and stops. The build-time origin
        // is the smallest of the three; the infrastructure and the store-distributed
        // builds are the ones that would still be there after a settings field.
        //
        // NO PROMISE, and no invitation. “Today” is a description of where things
        // stand, not a roadmap entry — docs/brand-assets.md, _the source_: nothing
        // here may read as a commitment about our future. It also stops short of
        // telling anyone how to try, because a half-followed attempt becomes a
        // support thread we have just said we do not take.
        id: 'self-hosting',
        q: 'Can I run it on my own server?',
        a: (
          <>
            Not today, and we would rather say so than let the licence imply otherwise. The builds
            we ship — web, mobile, and the browser extension — have our API’s address compiled in
            when they are built, so there is no setting that points one somewhere else, and the
            mobile and extension builds reach you through stores that only we can publish to. Behind
            that, the sync server is not a container you can run: it is a Cloudflare Worker wired to
            Cloudflare’s own databases and object storage, and its subscriptions run through our
            Paddle account. The {SOURCE.license}
            does not stop you building your own from the repository, and the code being public is
            what makes that possible at all — but it is not a path we document, and not one we can
            help you debug.
          </>
        ),
      },
    ],
  },
  {
    id: 'account',
    title: 'Your account and password',
    blurb: 'The part that has no reset button — worth five minutes now.',
    items: [
      {
        id: 'signup',
        q: 'What do I need to sign up?',
        a: (
          <>
            A username and a password. That is the whole form — no email address, no phone number,
            no card. We suggest the password the app generates for you: seven random words, long
            enough to be safe against an offline attack, which a memorable password is not.
          </>
        ),
      },
      {
        id: 'no-email',
        q: 'Why isn’t there an email address?',
        a: (
          <>
            Because there is nothing we could honestly do with one. There is no password reset to
            send, since we hold no key that could unlock your library. Nothing else needs it either
            — receipts come from our payment provider. An address we never collect is one that can
            never leak.
          </>
        ),
      },
      {
        // Four surfaces described this code four ways, and /terms had the only
        // account that matches the build: the sign-up ceremony OFFERS it and the
        // last step is labelled "Create account without a recovery code", so it is
        // skippable (docs/account.md, _the create-account ceremony_), and
        // `regenerateRecoveryDoor` / `useRecoveryCode` mean it can be minted or
        // replaced later from Settings against an existing door. "Generated when
        // you sign up", full stop, was wrong at both ends.
        //
        // The replaceability clause is the half that changes behaviour rather than
        // belief: a reader who thinks the code is a one-shot artefact treats losing
        // track of it as terminal, when in fact it is a chore they can redo any day
        // they can still sign in. It carries its own condition for exactly that
        // reason — replacing a door needs an open door.
        //
        // WHERE TO KEEP IT is stated here rather than left to `where-to-keep` four
        // items away, which answers a different question about a different secret.
        // The split — password in the manager, code somewhere else — is the site's
        // standing advice and the reason the second door exists; never advise
        // putting both in one place, whatever a reader's convenience argues.
        id: 'recovery-code',
        q: 'What is the recovery code?',
        a: (
          <>
            A second way into your account: a random code the app offers you when you create it,
            shown once. It opens the same library your password does, so it is what you use if the
            password is gone. Keep it somewhere different from your password — printed and filed, or
            in a safe — because the two failing together is the case it exists to survive. You can
            generate or replace one later in Settings, as long as you can still sign in.
          </>
        ),
      },
      {
        id: 'lost-password',
        q: 'What if I lose my password?',
        a: (
          <>
            Sign in with your recovery code, then set a new password. If both are gone, so is the
            library — no one at Bracemark can recover it, because no one here can decrypt it. That
            is the honest cost of the guarantee on the front page, and it is the reason the app asks
            you to save both.
          </>
        ),
      },
      {
        // ⚠ THE ONE ANSWER ON THIS PROPERTY THAT CAN SILENTLY PROMISE PROTECTION
        // THE BUILD DOES NOT PROVIDE. A password change is a tier-1 DOOR rotation:
        // prove an existing door, re-wrap the same DEK, upsert one `account_keys`
        // row (docs/account.md, _the DEK / KEK door model_ and the rotation status
        // callout). The DEK is UNCHANGED, so anything an attacker already decrypted
        // — or a wrapped blob they already pulled, since that blob is served
        // pre-auth — stays theirs forever. docs/account.md says it in one line: "A
        // leaked password needs DEK rotation, not a password change."
        //
        // This answer used to end "which is what you want if you are changing it
        // because you are worried", which sells the session revocation as the whole
        // remedy and lets a worried reader leave believing the break-in is undone.
        // The session half is TRUE and stays — it cuts off ongoing access, which is
        // real — but it now arrives with what it does not cover attached, because a
        // reader who works that out unaided stops believing the claims they cannot
        // check, and on this property that is most of them.
        //
        // DEK rotation ("Reset account security") is deferred and MUST NOT be
        // hinted at here — no "yet", no "coming soon". /pricing's rule holds for
        // the whole site: only what ships.
        id: 'change-password',
        q: 'Can I change my password?',
        a: (
          <>
            Yes, in Settings. It re-locks your key with the new password rather than re-encrypting
            your library, so it takes a moment, not an afternoon — and it signs out every other
            device, which cuts off anyone signed in with the old one. What it cannot do is unmake a
            copy: the key itself does not change, so anything someone already decrypted stays
            readable to them. Changing your password is the right move after a scare; it is not a
            way to undo a break-in that already happened.
          </>
        ),
      },
      {
        id: 'many-devices',
        q: 'Can I use it on more than one device?',
        a: (
          <>
            Yes, on as many as you like, on every plan. Sign in with the same username and password
            and the library is derived and decrypted there too.
          </>
        ),
      },
      {
        id: 'where-to-keep',
        q: 'Where should I keep my password?',
        a: (
          <>
            A password manager is the best answer. A notes app that locks, or paper somewhere only
            you would look, both work. Don’t keep it on a site you don’t trust: anyone with it has
            your library.
          </>
        ),
      },
    ],
  },
  {
    id: 'billing',
    title: 'Plans and billing',
    blurb: 'What it costs, and what happens if you stop paying.',
    items: [
      {
        id: 'cost',
        q: 'How much does Bracemark cost?',
        a: (
          <>
            Free for your first {FREE_LINKS} links, with no card. {PLAN_LABELS.plus} is $
            {PLAN_USD_PER_YEAR.plus} a year — unlimited links, nested and hidden lists, the app lock
            and the structured search editor — and starts with a {TRIAL_DAYS}-day free trial.
            Everything is on the <PageLink href="/pricing">pricing page</PageLink>.
          </>
        ),
      },
      {
        // Currency gets its own answer rather than a clause inside _refunds_:
        // it is the question a non-US buyer actually asks, and the honest answer
        // has to distinguish a price we SET per currency from an exchange-rate
        // conversion, which no surface does. → docs/iap.md, _currency_.
        id: 'currency',
        q: 'What currency will I be charged in?',
        a: (
          <>
            Prices on this site are shown in US dollars, which is our base price. Some countries are
            priced in their own currency instead — if yours is one of them, that is what you will be
            charged, at a price we set rather than a live exchange-rate conversion. Either way the
            web app shows your exact price, in your currency and with any tax, on the upgrade card
            and again in the checkout before you pay. In the iOS and Android apps the App Store and
            Play Store set the local price, and you see it in the store’s own purchase sheet.
          </>
        ),
      },
      {
        id: 'free-cap',
        q: `What happens when I reach ${FREE_LINKS} links?`,
        a: (
          <>
            Nothing is deleted and nothing is locked away. You keep reading, searching, editing,
            deleting and exporting the whole library; new links stop saving until you upgrade or
            make room. Upgrading lifts the cap straight away. That is also what happens if a trial
            ends with more than {FREE_LINKS} links in your library — they all stay, and stay
            exportable; you just cannot add new ones until you are back under the cap or on{' '}
            {PLAN_LABELS.plus}.
          </>
        ),
      },
      {
        // The question every switcher asks and no surface used to answer. The
        // honest version is unflattering in one clause (the file does not all
        // fit) and reassuring in the rest (nothing is written until you say so,
        // and re-importing later finishes the job) — see docs/data-lifecycle.md,
        // _the import's quota gate_.
        id: 'import-over-cap',
        q: `What if I import more than ${FREE_LINKS} links?`,
        a: (
          <>
            The file is read on your device and counted before anything is saved, so you find out up
            front rather than halfway through. If it holds more new links than your plan has room
            for, Bracemark tells you both numbers and asks: bring in the ones that fit, or stop and
            import the whole file once you have room. Nothing is written until you pick, and the
            file on your device is never changed. If you take the ones that fit, importing the same
            file again later brings in the rest — the links already saved are skipped as duplicates.
            One exception: a Bracemark backup (.zip) is all-or-nothing, because a half-restored
            backup is worse than none.
          </>
        ),
      },
      {
        // The advice branches because the old single answer ("start it when the
        // free plan begins to pinch") is right for someone starting fresh and
        // wrong for everyone arriving with a library — for them it pinches at
        // minute one, and the import is the decision. The card sentence is here
        // because a trial that takes a payment method should say so on a site
        // that makes a point of saying "no card" everywhere it is true.
        id: 'trial',
        q: 'Is there a free trial?',
        a: (
          <>
            Yes — {PLAN_LABELS.plus} starts with {TRIAL_DAYS} days free, on the annual plan, and
            cancelling before the end means no charge. Starting it goes through checkout, so it
            takes a payment method; nothing is charged unless the trial runs to the end. When to
            start it depends on which door you came in: if you are arriving with a library to
            import, day one — the cap is the first thing you will meet, and whether the structure
            suits your links is a question your own library answers. If you are starting fresh, wait
            until the free plan begins to pinch, because the trial demos things a twelve-link
            library cannot feel yet.
          </>
        ),
      },
      {
        id: 'monthly',
        q: 'Do you have a monthly plan?',
        a: (
          <>
            Not yet. Bracemark is annual-only for now, and we would rather sell one honest plan than
            a monthly one you couldn’t switch out of. It is on the list.
          </>
        ),
      },
      {
        id: 'lifetime',
        q: 'Is there a lifetime plan?',
        // Mirrors the pricing page's lifetime strip: both read LIFETIME_ON_SALE, so
        // the offer appears everywhere at once or nowhere, and the FAQ can never
        // deny something the pricing page is selling.
        a: LIFETIME_ON_SALE ? (
          <>
            Yes, as a launch offer: ${LIFETIME_USD} once for {PLAN_LABELS[LIFETIME_PLAN]} forever,
            limited to the first {LIFETIME_SEATS} people. When those are gone the offer retires for
            good.
          </>
        ) : (
          <>
            Not at the moment. Running the service costs something every year, so a price that only
            ever gets paid once has to be set carefully. If we offer one it will be as a capped
            launch deal, announced here first.
          </>
        ),
      },
      {
        id: 'refunds',
        q: 'How do payments and refunds work?',
        a: (
          <>
            Payments on the web go through Paddle, which acts as the merchant of record: it handles
            any sales tax or VAT and we never see your card details. Purchases made in the iOS or
            Android apps are handled by Apple and Google under their own refund rules. If something
            has gone wrong, write to <MailLink address={SUPPORT_EMAIL} /> and we will sort it out —
            and customers in the EU and UK have a statutory 14-day right of withdrawal on top of
            anything we offer.
          </>
        ),
      },
      {
        // The user-facing side of "a downgraded account degrades to
        // read-only-plus-delete, never data loss" (docs/iap.md, _quota_ — where it is
        // also a test, sync.spec.ts). Two halves, and this answer used to carry only
        // the first:
        //   - never data loss — "you keep it", which /terms says too;
        //   - plus-DELETE — editing and deleting keep working. Not a footnote: the
        //     link cap was deliberately moved off the server so that an account at
        //     its cap can still retitle and trash, trashing being the only route back
        //     under it (docs/iap.md, _why the link cap is not here_). An answer that
        //     omits it hides the escape hatch from the one person who needs it.
        // The locks/nesting sentence is the same promise applied to the Plus levers,
        // and it is the reassurance a reader with a hidden list actually wants:
        // `nestedLists` and `locks` are read at the CREATE affordances only (the
        // reparent gate, the import folder expansion, the add-lock buttons) — nothing
        // flattens or strands what an ex-Plus account already made (docs/locks.md,
        // _entitlement_). If that ever changes, this answer is wrong, not stale.
        id: 'stop-paying',
        q: 'What happens to my data if I stop paying?',
        a: (
          <>
            You keep it, and you keep using it. The whole library stays readable, searchable and
            exportable on the free plan, and you can still edit, retag and delete anything in it —
            which is also how you get back under the free cap if you are above it. What stops is
            adding new links past that cap and creating new {PLAN_LABELS.plus} structure; nothing
            you already made is taken away or stranded, so nested lists stay nested and can always
            be flattened, and an existing lock still opens with your password and can always be
            removed. Export is free on every plan, forever — charging you to leave would undo the
            point of building it this way.
          </>
        ),
      },
      {
        id: 'crypto-payment',
        q: 'Can I pay in Bitcoin or another cryptocurrency?',
        a: (
          <>
            Not today. We rely on a payment provider to handle sales tax and accounting across
            countries, and we take what it supports. If that changes we will turn it on.
          </>
        ),
      },
      {
        id: 'subscribed-still-locked',
        q: 'I subscribed, but the features are still locked.',
        a: (
          <>
            Give it a minute — activation arrives from the payment provider a few seconds after
            checkout. If it hasn’t landed, open Settings → Subscription and restore your purchase;
            if it still hasn’t, write to <MailLink address={SUPPORT_EMAIL} /> with the date and the
            store you bought it from.
          </>
        ),
      },
    ],
  },
  {
    id: 'using',
    title: 'Using Bracemark',
    blurb: 'The day-to-day questions.',
    items: [
      {
        // Two halves, and only the first one existed anywhere for the whole
        // first public stretch. Every surface explained a missing preview as a
        // CLIENT-or-PLAN matter — which device saved it, or turn on the opt-in —
        // and none of them said a PAGE can simply refuse. But `verdictForStatus`
        // (packages/shared/src/extract/retry.ts) settles 404/410/451, the auth
        // walls, a non-HTML content type, an empty body and a persistent 403 as
        // `permanent`: never retried again by any device, deliberately. So a
        // Plus user who ran Generate all and landed on a `Failed: 34` that never
        // moves had nothing on any surface telling them that number is finished
        // rather than stuck — which reads as a broken feature, and is the sort
        // of claim a reader falsifies from their own screen. The causes below
        // are drawn from `verdictForStatus`; keep them in step with it. The
        // settings pane carries the same fact next to the number itself.
        //
        // "The browser won’t let a web page fetch another site" is shared VERBATIM
        // with the landing page's web-app capture card (app/page.tsx, `CAPTURE`),
        // which took its wording from here so the two surfaces read as one voice.
        // Nothing links them — different files, no import, no test — so reword one
        // and the other silently disagrees about the single fact that explains why
        // server extraction has to exist at all. Keep the actor the web PAGE:
        // same-origin binds the document running in the browser, not sites, and a
        // server fetching another site is exactly what the sentence goes on to
        // sell (docs/link-extraction.md, _server extraction_).
        id: 'no-title-image',
        q: 'Why don’t some of my links show a title or image?',
        a: (
          <>
            A preview comes from the device that saved the link, and it takes a moment to arrive.
            Links saved in the web app are the exception — the browser won’t let a web page fetch
            another site — so those show the bare address unless you turn on the opt-in{' '}
            {PLAN_LABELS.plus} extraction. Installing the browser extension is the free fix, and the
            better one. Some pages give nothing up whichever device asks, and no plan changes that:
            anything behind a login or a paywall, a PDF or another file that isn’t a web page, a
            site that turns away automated requests, and pages whose text is assembled by JavaScript
            after they load. We stop retrying those, so they land in the failed count under Link
            previews in Settings rather than a queue that is still working on them. The link is
            saved either way, and you can give it a title of your own.
          </>
        ),
      },
      {
        id: 'nested-lists',
        q: 'Can I put lists inside lists?',
        a: (
          <>
            Yes, on {PLAN_LABELS.plus}. The free plan gives you flat lists, tags and pins, which is
            enough structure for a library of {FREE_LINKS} links; nesting starts to matter at the
            size the paid plan is for.
          </>
        ),
      },
      {
        id: 'link-note',
        q: 'Can I add a note to a link?',
        a: (
          <>
            Yes, on every plan — one short note per link, up to {LINK_NOTE_MAX} characters, added
            when you save it or from “Edit note” in the link’s menu. It is encrypted on your device
            with the link itself, so it is as unreadable to us as the address is. The search box
            matches titles and addresses; to search your notes, use the “Note contains” field in the{' '}
            {PLAN_LABELS.plus} search editor.
          </>
        ),
      },
      {
        id: 'per-device',
        q: 'Can I have a different layout on my laptop and my phone?',
        a: (
          <>
            Yes. Both the layout and the theme can either sync across your devices or be set per
            device — switch the setting from “Sync” to “Device” and that machine keeps its own
            choice.
          </>
        ),
      },
      {
        // The conflict policy, which was written down in docs/local-first-sync.md
        // (_conflict policy_) and had never reached a page. A reader arriving from
        // a sync product that burned them looks for this answer first, and a
        // silence where a policy should be reads as evasion rather than as an
        // omission — the more so on a property whose whole method is itemising.
        //
        // Every clause is a fact about the shipped engine, not a promise:
        //   - ONE ENTITY PER FILE (`links/{id}.enc`, `lists/{id}.enc`,
        //     `tags/{id}.enc`) is what makes the granularity claim true: two
        //     devices touching different links write different R2 objects and
        //     never contend.
        //   - LAST-WRITER-WINS on the same path, and the earlier edit is lost
        //     SILENTLY. Said plainly because it is the real cost, and because the
        //     reason we cannot do better is the same architecture the rest of the
        //     page sells: there is no readable copy server-side to merge, and no
        //     version history to roll back to. The band on the landing page makes
        //     the same trade in the same words.
        //   - THE EXTRACTION SPLIT is not a detail, it is the reassurance: the
        //     metadata blob is split by WRITER — `links/{id}.enc` user-authored,
        //     `extractions/{id}.enc` machine-derived, same id — precisely so a
        //     background title fetch can never clobber a title you typed.
        //
        // NOT MENTIONED, DELIBERATELY: R2 conditional writes (`If-Match` on the
        // etag) are the designed upgrade and are deferred, and the true-conflict
        // winner (local-wins vs server-wins) is an open product call. Neither is a
        // thing that ships, so neither belongs on a page whose rule is only what
        // ships — and "we plan to fix this" is the answer a sync-burned reader
        // trusts least of all.
        id: 'two-devices',
        q: 'What happens if I change the same link on two devices?',
        a: (
          <>
            Each link, list and tag is stored as its own encrypted file, so two devices working on
            different things never collide. If the same link is edited in both places before they
            sync, the later edit is the one that survives and the earlier one is replaced — we hold
            nothing readable at our end, so there is no merge we could do for you and no older
            version to restore. Anything you change offline queues up and goes out in order the next
            time you have a network. Titles and preview images fetched in the background are kept in
            a separate file from what you write, so one never overwrites the other.
          </>
        ),
      },
      {
        id: 'dark-mode',
        q: 'Is there a dark theme?',
        a: (
          <>
            Yes — light, dark, follow the system, or switch at times you choose. Ours is a dark grey
            rather than pure black.
          </>
        ),
      },
      {
        id: 'locks',
        q: 'What is the app lock?',
        a: (
          <>
            A {PLAN_LABELS.plus} feature that puts a lock over the app, and lets you hide individual
            lists from view. It sits on top of the encryption rather than replacing it — encryption
            protects your library from us and from anyone who gets the files; the lock protects it
            from whoever is standing behind you.
          </>
        ),
      },
      {
        id: 'sharing',
        q: 'Can I share a list with someone?',
        a: (
          <>
            Not today. Sharing means handing someone the ability to decrypt part of your library,
            which is real key-exchange work rather than a button, and public sharing would drag in
            moderation duties we would then have to act on. We would rather not ship a shallow
            version of it.
          </>
        ),
      },
      {
        id: 'import-export',
        q: 'Can I bring my bookmarks in, and take them out again?',
        a: (
          <>
            Both. Import a browser bookmarks export, a Raindrop CSV or a plain list of URLs — the
            file is read on your device and never uploaded. If it holds more links than your plan
            has room for, you are asked before anything is saved (see{' '}
            <PageLink href="/faq#import-over-cap">
              what if I import more than {FREE_LINKS} links
            </PageLink>
            ). Export gives you the whole library on every plan: a full backup that restores
            everything, or one of three formats other apps read — a browser bookmarks file, a CSV
            carrying the address, list, title, note, tags and date of every link, and a plain list
            of URLs.
          </>
        ),
      },
      {
        id: 'delete-account',
        q: 'How do I delete everything?',
        a: (
          <>
            Settings → Data wipes your library and keeps the account; Settings → Account deletes the
            account itself, which also destroys the keys that could ever have opened it. Neither can
            be undone, so both ask you to confirm first.
          </>
        ),
      },
    ],
  },
];

// The subset /pricing repeats next to the plan cards — the questions a buyer asks
// with a card in their hand, in the order they ask them. Ids, not copies.
// `import-over-cap` earns its place here: on the pricing page the cap is the
// number a switcher is reading, and "what happens to my 1,200 links" is the
// question it raises.
export const PRICING_FAQ_IDS = [
  'free-cap',
  'import-over-cap',
  'trial',
  'stop-paying',
  'refunds',
] as const;

export function faqById(id: string): FaqItem | undefined {
  for (const group of FAQ_GROUPS) {
    const found = group.items.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}
