import Link from 'next/link';

import {
  entitlementsOf,
  LIFETIME_ON_SALE,
  LIFETIME_PLAN,
  LIFETIME_SEATS,
  LIFETIME_USD,
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
      className="text-signal decoration-signal-line hover:decoration-signal rounded-sm underline underline-offset-2"
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
      className="text-signal decoration-signal-line hover:decoration-signal rounded-sm underline underline-offset-2"
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
      className="text-signal decoration-signal-line hover:decoration-signal rounded-sm underline underline-offset-2"
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
        id: 'offline',
        q: 'Does it work offline?',
        a: (
          <>
            Yes. Bracemark is local-first: the app reads from a copy of your library held on the
            device, so it opens, browses and searches with no connection at all. Anything you change
            while offline is queued and syncs the next time you have a network.
          </>
        ),
      },
      {
        id: 'need-extension',
        q: 'Do I have to install the browser extension?',
        a: (
          <>
            No, but it is the best way to save. The extension reads the page you are already looking
            at, so the title and preview image come from your own browser and nothing has to fetch
            that page on your behalf. Saving from the web app works without it — see the previews
            question below for what changes.
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
        id: 'previews',
        q: 'If everything is encrypted, how do link previews work?',
        a: (
          <>
            The device that saves the link does the fetching. The browser extension reads the tab
            you are on; the mobile apps fetch the page themselves. Neither involves us, and both are
            free. The exception is a link saved in the web app, where the browser blocks a page from
            fetching another site — that one needs a server to fetch on your behalf, so it is an
            opt-in {PLAN_LABELS.plus} feature, off until you turn it on. The service that does it
            holds no key, stores nothing, and never sees your account.
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
            {SOURCE.license}: the apps, the sync server and the key derivation, in one repository.
            You can read where the key comes from, where encryption happens, and what the server is
            given. One caveat we would rather state than have you assume: reading the source proves
            what the code does, not that the bundle your browser downloaded was built from it. That
            needs reproducible builds, and we do not publish them yet.
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
            no card. We suggest the passphrase the app generates for you: it is long enough to be
            safe against an offline attack, which a memorable password is not.
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
        id: 'recovery-code',
        q: 'What is the recovery code?',
        a: (
          <>
            A second way into your account, generated at random and shown once when you sign up. It
            opens the same library your password does, so it is what you use if the password is
            gone. Keep it somewhere different from your password — the two failing together is the
            case it exists to survive.
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
        id: 'change-password',
        q: 'Can I change my password?',
        a: (
          <>
            Yes, in Settings. Changing it re-locks the key rather than re-encrypting your library,
            so it takes a moment, not an afternoon — and it signs out every other device, which is
            what you want if you are changing it because you are worried.
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
        q: 'Where should I keep my passphrase?',
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
        id: 'no-title-image',
        q: 'Why don’t some of my links show a title or image?',
        a: (
          <>
            A preview comes from the device that saved the link, and it takes a moment to arrive.
            Links saved in the web app are the exception — the browser won’t let a web page fetch
            another site — so those show the bare address unless you turn on the opt-in{' '}
            {PLAN_LABELS.plus} extraction. Installing the browser extension is the free fix, and the
            better one.
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
            ). Export gives you the whole library as a full backup or in the formats other apps
            read, on every plan.
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
