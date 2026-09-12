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

import { MailLink } from '../components/mail-link';
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

// The same-surface sibling of PageLink, and a plain <a> for the same reason
// ExternalLink is one: a fragment has no route to prefetch either. It exists
// because WHERE a sibling answer sits is a property of the page rendering it,
// not of the answer — this file is content, shared by /faq and /pricing, and an
// answer that hard-codes `/faq#…` is asserting a surface it cannot see. On /faq
// the fragment lands on that question's <details>; on /pricing, where the same
// answer is one of `PRICING_FAQ_IDS`, it lands on the target's grid cell.
//
// ⚠ THE FAILURE IS SILENT. A fragment whose target is not on the page scrolls
// nowhere at all — no error in the console, no lint rule, no type error, no
// failing build, and the reader gets a link that does nothing. Nothing links
// this component to `PRICING_FAQ_IDS` below, so dropping an id from that list
// can strand a link inside an answer that stayed. `faq-cross-links.spec.tsx`
// beside this file is what holds the two together; read its header before
// changing either list.
//
// USE IT ONLY BETWEEN FAQ ANSWERS. A surface that is not the FAQ — /security's
// pointer at `compelled`, say — has no such fragment on it and must keep the
// absolute `/faq#…` form.
function HashLink({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <a
      className="rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal"
      href={`#${id}`}
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
            device, with a key your password unlocks, before any of it syncs. We store the result
            and cannot open it.
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
            their server-side search and recommendations possible in the first place. Our API never
            receives your library in plaintext, so search and organisation happen on your own
            devices. Link previews are fetched there too unless you choose the web app’s opt-in
            preview server.
          </>
        ),
      },
      {
        // `vs-others` above stops at the three hosted answers, which leaves out
        // the reader whose current system is a folder of plain files and who is
        // the closest thing this product has to a natural buyer: someone who has
        // already decided that owning the bytes matters and has already paid the
        // price of it. Nothing on the property was written to them.
        //
        // IT WINS BY CONCEDING, which is the only way this one can be won. The
        // folder is not a worse idea — it is the same idea with the hard half
        // still to do, and saying so is both true and more persuasive than a
        // comparison would be. The answer's whole weight then falls on the
        // export, because the concession is only credible if the folder is still
        // there at the end: a reader who is told "you can leave with plain files"
        // is being offered the thing they already have, plus the sync.
        //
        // The export sentence deliberately echoes DURABILITY's on the landing
        // page (app/page.tsx, the export entry) rather than paraphrasing it. Two
        // surfaces describing the same archive in two ways is how "four formats"
        // came to be claimed five times and described once; if the archive's
        // shape changes, both move together. No API is implied and none is
        // promised — /about names its absence and that stays the only mention.
        id: 'folder-of-files',
        q: 'Why not just keep links in a folder of files?',
        a: (
          <>
            It is a good instinct and we are not going to argue you out of it. But a folder is
            either readable by anyone who reaches the disk — a backup, a synced drive, a borrowed
            laptop — or it is encrypted, and the moment it is encrypted you have taken on the hard
            half yourself: getting it onto a phone, opening it there, searching it without a server
            to search for you, and never losing the key. That is the work Bracemark is. What you get
            for handing it over is that the folder is still waiting at the end: the complete backup
            is a zip of one JSON line per item, your preview images beside it as ordinary files,
            decrypted, readable in a text editor with nothing of ours installed. Export as often as
            you like, on every plan — if you would rather keep the folder and use this as the part
            of it that runs on your phone, that is a reasonable way to use it.
          </>
        ),
      },
      {
        // The other half of the audience gap `folder-of-files` opens, and the
        // second reader `vs-others` leaves out: the one who buys privacy by the
        // vendor rather than by the app, and whose real alternative is not
        // another bookmark manager but WAITING for a suite he already pays for to
        // ship one. Nothing on the property was written to him, and he is not a
        // hard sell for the architecture — he is sold on it already, which is why
        // he is shopping for a vendor rather than a feature.
        //
        // It concedes for the same reason `folder-of-files` does, and harder,
        // because both of his reasons are good: one bill is cheaper than two, and
        // one account is one recovery story to get right instead of two. Arguing
        // either away would be the pitch-deck register this site does not use, and
        // the concession is what makes the last line land — a reader told he can
        // leave whenever he likes has no reason not to start now.
        //
        // The one thing it asserts about a product that does not exist yet is a
        // CONSTRAINT, not a shortcoming: a server that cannot read your links
        // cannot search them either, whoever runs it. That is this site's own
        // argument pointed at a hypothetical competitor, and it stays true however
        // good the competitor turns out to be. No company is named and no one's
        // roadmap is guessed at — both would date, and one would be a claim about
        // someone else we have no standing to make.
        //
        // The export is NOT re-described here. `folder-of-files` above and
        // DURABILITY on the landing page already carry the bytes, and a third
        // spelling of the same archive is how "four formats" came to be claimed
        // five times and described once.
        id: 'privacy-suite',
        q: 'Why not wait for a privacy suite I already pay for to add this?',
        a: (
          <>
            That may well be the right call, and nothing here punishes you for waiting: the free
            plan is {FREE_LINKS} links with no time limit, and export is free on every plan, so
            starting now costs you nothing you cannot walk back. A suite gives you two things we
            cannot: one subscription instead of two, and one account to keep safe rather than
            another password and another recovery code. What the second subscription buys is a
            product that does only this: the lists, the tags, the search, the previews, the browser
            extension, and sharing into the app from anywhere are the whole of what we work on,
            rather than a feature fitted in beside the rest of a suite. And one thing does not
            change with the size of the company behind it — a server that cannot read your links
            cannot search them for you either, so anything encrypted the way this is inherits the
            same trade we did: search that runs on your device, and no server-side features. If a
            suite ships one that fits you better, take it. Your library leaves with you.
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
            from whatever app you are in — the link is saved on the spot and, with the default Link
            previews setting, the app fetches the page itself the next time you open Bracemark.
            Saving from the web app works without either — see the previews question below for what
            changes.
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
        // THE SESSIONS ROW BELONGS IN THE LIST. This answer named three of the
        // four plaintext things we hold and stopped, while the landing page's
        // `Our blindness` entry and /privacy both name the session record — so
        // the FAQ, which is where a careful reader comes to check the landing
        // page, was the least complete of the three. `compelled` below then
        // inherited the gap by pointing back here ("the account record described
        // above"), which is how one omission became two.
        //
        // It is not a closed enumeration either way — the last line points at the
        // inventory rather than standing in for it, which is the shape the
        // privacy claims were rewritten to — but "the full inventory is over
        // there" is a weaker promise when the list in front of it is visibly
        // short of a field the reader has already seen elsewhere on the site.
        id: 'what-we-see',
        q: 'What can your servers actually see?',
        a: (
          <>
            The username you chose, a public key that lets us check a sign-in signature, a session
            record for each device you are signed in on, and a set of encrypted files — each with a
            path, a size, and the time it last changed. If you subscribe, a subscription record too.
            Not one title, address, tag or note, and no search index over any of it. The full
            inventory is in the <PageLink href="/privacy">privacy policy</PageLink>.
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
        // THE CARVE-OUT IS SCOPED TO THIRD-PARTY CODE, never to the four Nos in
        // front of it. "One screen is the exception" pointed back at the whole
        // list, so the answer read as though analytics, an ad SDK and
        // fingerprinting all turn up on Settings → Subscription — an exception
        // four times wider than the fact, in the answer a reader opens to check
        // the landing page's `No trackers` cell against. Both sibling surfaces
        // already name what the one screen is an exception TO (app/page.tsx,
        // that cell: "the only third-party script we load"; /privacy: "loads no
        // third-party code except in one place"), and this was the only one of
        // the three that did not. Naming the scope is also what lets the
        // sentence keep its own "only": one script, and no second screen.
        //
        // THE NOS ARE CLAIMS ABOUT US — we run, we ship, we set — and the verbs
        // are what make them safe standing next to a third-party script. As
        // absolutes about the product ("no fingerprinting, anywhere in
        // Bracemark") they invite the one question we have no standing to
        // answer: what Paddle's script does inside its own checkout. A tidying
        // hand puts the shorter noun-phrase list back; it is shorter because it
        // claims more than we can check.
        //
        // "MUST LOAD", not "loads": the script is a condition of the screen
        // rather than something we chose to add, and it arrives WITH the screen
        // — `Paddle.PricePreview` looks the local price up on mount, not at
        // checkout. That is pinned by privacy/page.tsx's header (the
        // third-party-script claim), which pins the rest of this answer too —
        // one script, that screen, Paddle's the only cookies anywhere in
        // Bracemark, fonts served by us — and says the two surfaces move
        // together. Adding a script to either property falsifies both.
        id: 'trackers',
        q: 'Do you use cookies, trackers, or analytics?',
        a: (
          <>
            We run no analytics, ship no advertising SDK, fingerprint nothing and set no cookies of
            our own, anywhere in Bracemark. One screen loads code that isn’t ours: opening Settings
            → Subscription must load Paddle’s script, to show your price in your own currency and to
            run the checkout if you subscribe. That script is the only third-party code in
            Bracemark, and the cookies it sets are the only cookies. Even the fonts come from us
            rather than from a font provider. Bracemark does keep data in your browser, but it is
            your library, kept there so it works offline.
          </>
        ),
      },
      {
        // THE PAGE THAT EXISTS TO ANSWER THIS ONE WAS THE THINNEST ON IT. A
        // reader who needs this answer needs to write something down — a risk
        // assessment, a policy exception, a note to a client — and "ciphertext
        // plus the account record described above" is not a thing anyone can
        // transcribe. It could be assembled from the landing page's hero panel
        // and `Our blindness` and /privacy's processor list, and every reader
        // who wanted it went and did exactly that. Itemising it here costs
        // nothing we have not already published and saves them the assembly.
        //
        // THREE THINGS IT MUST NOT DO. It must not close the enumeration — hence
        // the pointer at /privacy carrying both the provider lines and our own
        // fields, the `Our blindness` shape rather than "that is the whole of
        // it". It must not promise conduct /terms does not carry: the notice
        // sentence is the fact (no email address, so no private channel) plus
        // the channel /terms already commits to (clause 445, "we give notice on
        // this website"), and it stops there — it does NOT say we would tell you
        // about a particular order, which is not ours to promise and is often
        // not lawful to do. And it must not drift into a warrant canary: an
        // absence-of-requests claim is a commitment to keep repeating it, which
        // is a decision to take deliberately or not at all, not something to
        // arrive at by writing one more clause.
        //
        // "Served independently" is the half that is actually load-bearing for a
        // compliance reader and the half no surface said: our inability to
        // decrypt is not a property of the whole supply chain, and pretending
        // otherwise is the same error as narrowing "the server" to a sync server
        // that does not exist.
        id: 'compelled',
        q: 'What if someone compels you to hand over my bookmarks?',
        a: (
          <>
            We can only hand over what we hold. An order served on us reaches your encrypted files
            and the metadata that rides with them — a path, a size, the time each last changed —
            together with the account record: the username you chose, the public key your sign-ins
            are checked against, the sessions that keep your devices signed in, and a subscription
            record if you pay. It does not reach a link, a title, a tag or a note, and there is no
            key on our side to compel, because one was never there. An order also does not have to
            come to us at all: Cloudflare stores the encrypted files and the account databases,
            Amazon Web Services serves this website and the app, and Paddle holds the payment
            details we never see — each can be served for its own part, and the{' '}
            <PageLink href="/privacy">privacy policy</PageLink> lists every provider, what it holds,
            and every field we hold ourselves. One more thing worth saying plainly: we hold no email
            address for you, so we have no private channel to warn anyone through, and the only
            notice we can give is the notice we give on this website.
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
            The browser extension reads the live tab and tries to fill in its title and preview
            image every time you save. The mobile apps fetch pages themselves: by default they cover
            links saved on that device, and the All links setting also covers synced and imported
            links as they come into view. With All links selected, Generate all works through every
            pending link. Those paths are free and involve no server of ours. In the web app, the
            browser blocks one page from fetching another site. Turn on the opt-in{' '}
            {PLAN_LABELS.plus} preview server and new saves, older links, synced links and imports
            fill in as you browse; Generate all covers the rest. The service holds no key and
            receives no account identity. It stores no URL or page content; its rate limiter briefly
            holds the requesting IP address to stop one source abusing it.
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
            mobile and browser extension builds reach you through stores that only we can publish
            to. Behind that, the sync server is not a container you can run: it is a Cloudflare
            Worker wired to Cloudflare’s own databases and object storage, and its subscriptions run
            through our Paddle account. The {SOURCE.license} does not stop you building your own
            from the repository, and the code being public is what makes that possible — but it is
            not a path we document, and not one we can help you debug.
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
            A username and a password. That is all we ask for — no email address, no phone number,
            no card. We suggest the password for you: seven random words, long enough to survive an
            offline attack in a way most typed passwords are not. You can choose your own instead.
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
            A second way into your account: a random code we offer you when you create your account,
            shown once. It opens the same library your password does, so it is what you use if the
            password is gone. Keep it somewhere different from your password — printed and filed, or
            in a safe — because if both are lost at once, there is no way back into your account and
            nothing in it can be recovered. You can generate or replace the code later in Settings,
            as long as you can still sign in.
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
            and again in the checkout before you pay. In the iOS and Android apps, the App Store and
            Play Store set the local price, and you see it in the store’s own purchase sheet.
          </>
        ),
      },
      {
        id: 'free-cap',
        q: `What happens when I reach ${FREE_LINKS} links?`,
        a: (
          <>
            Nothing is deleted and nothing is put out of reach. You keep reading, searching,
            editing, deleting and exporting the whole library; new links stop saving until you
            upgrade or make room. Upgrading lifts the cap straight away. That is also what happens
            if a trial ends with more than {FREE_LINKS} links in your library — they all stay, and
            stay exportable; you just cannot add new ones until you are back under the cap or on{' '}
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
            import the whole file once you have room for all of it. Nothing is written until you
            pick, and the file on your device is never changed. If you take the ones that fit,
            importing the same file again later brings in the rest — the links already saved are
            skipped as duplicates. One exception: a Bracemark backup (.zip) is all-or-nothing,
            because a half-restored backup is worse than none.
          </>
        ),
      },
      {
        // The card sentence is here because a trial that takes a payment method
        // should say so on a site that makes a point of saying "no card"
        // everywhere it is true.
        //
        // THE DAY-ONE ADVICE IS CONDITIONAL, and the flat version of it ("if you
        // are bringing a library with you, start on day one") was wrong for most
        // of the people it addressed. A switcher whose file fits under the cap
        // gets nothing from the trial on day one, and telling them to start it
        // anyway is the salesmanship this property otherwise refuses — with a
        // real cost attached, since the trial takes a payment method and renews
        // into a charge. The cap is the ONE condition, and `import-over-cap`
        // above is its mechanism; this answer only says when to have upgraded by.
        //
        // A second condition stood here for one revision — nested folders, which
        // the import used to flatten on the free plan — and it is gone because
        // the build changed under it rather than because the sentence was wrong.
        // The import now builds the tree its folder paths name on every plan
        // (`shared/src/import/project.ts`, the header; docs/data-lifecycle.md,
        // _the shapes_), so there is no longer a structural decision taken at
        // import time to be day-one about. NOTHING replaces it here: a reader
        // whose only question is nesting is answered by `nested-lists` in the
        // using group, and this answer is about when to spend the trial.
        //
        // "THERE IS NO RUSH" IS THE MECHANISM, not modesty: the free plan has no
        // time limit and the clock starts on demand, so a trial started before
        // there are links to try it on spends {TRIAL_DAYS} days on nothing. The
        // replaced clause ("wait until the free plan begins to pinch") said the
        // same thing as a feeling rather than as a fact, and left the reader with
        // no way to tell when that was.
        //
        // The cap is FREE_LINKS in both branches, never a written-out number.
        // This answer ended on "a twelve-link library" for a while, which is the
        // header's rule failing in the way it fails — the cap moved to 200 in
        // `iap/plans`, every interpolated mention followed it, and the one spelled
        // in words stayed behind, wrong by an order of magnitude and readable as
        // a plan detail rather than as a typo.
        id: 'trial',
        q: 'Is there a free trial?',
        a: (
          <>
            Yes — {PLAN_LABELS.plus} starts with {TRIAL_DAYS} days free, on the annual plan.
            Starting it goes through checkout, so it takes a payment method, but nothing is charged
            if you cancel before the {TRIAL_DAYS} days are up. There is no rush to start: the free
            plan has no time limit, and the {TRIAL_DAYS} days only begin when you begin them — so
            you can start the trial whenever you have something for it to do. If you are importing a
            library of more than {FREE_LINKS} links, that is day one — the cap is the first thing
            you will meet. Otherwise start it when you want one of the {PLAN_LABELS.plus} features.
          </>
        ),
      },
      {
        // The argument this replaced ("we would rather sell one honest plan than
        // a monthly one you couldn't switch out of") lost the sale it was written
        // to defend: annual IS the plan you cannot switch out of, so the sentence
        // refuted itself in front of the reader least able to afford the bet, and
        // read as the one piece of salesmanship on a property that otherwise
        // refuses it. The answer now does what the rest of the site does — name
        // the cost, then name the mechanisms that bound it, and let the reader do
        // the arithmetic we would otherwise be doing at them.
        //
        // The third bound is the one the objection is actually about: prepaying a
        // year to a company that has not launched. It is scoped exactly as
        // terms/page.tsx scopes it — WE stop offering the plan, for reasons within
        // our control — and not to a change of mind, which is Paddle's, Apple's or
        // Google's policy rather than ours. Widening it here would promise conduct
        // the Terms do not carry, which is the failure mode this file is most
        // exposed to: marketing copy is where a commitment gets invented.
        //
        // The statutory withdrawal right is deliberately NOT restated here.
        // `refunds` owns the refund position, and two answers stating it drift
        // apart within a release or two (the header's whole argument for one
        // file); this one points at it instead.
        //
        // NO ROADMAP ENTRY, AND "TODAY" RATHER THAN "YET". This answer closed on
        // "A monthly plan is on the list" for several releases, which is the one
        // construction every sibling surface refuses in as many words: /about's
        // `No public API` ("today", never "yet" — a commitment nobody made),
        // /security on the audit and on reproducible builds, /pricing's hidden
        // lifetime strip, and `change-password` above on DEK rotation. It also
        // inverted this answer's own method — the trial, the cancellation and the
        // Terms clause are all bounds the reader can check, and the roadmap line
        // sat LAST, closing an argued answer on its one unverifiable clause. On
        // /pricing, where `monthly` is one of PRICING_FAQ_IDS and is read with a
        // card in hand, the only act it suggested was to wait.
        //
        // The opening carries the same rule: "Not today" describes where things
        // stand, "Not yet" is a promise in two words — which is why `self-hosting`
        // above and `crypto-payment` below both say today. If a door ever needs
        // leaving open, the house shape is the CONDITIONAL — `lifetime`'s off-sale
        // branch, `crypto-payment`'s last line — never an assertion that a thing
        // is planned.
        id: 'monthly',
        q: 'Do you have a monthly plan?',
        a: (
          <>
            Not today — {PLAN_LABELS.plus} is annual only, and that carries a real cost for you: a
            year up front is a larger commitment than a month, made before you know whether this
            fits the way you work. What bounds it: the {TRIAL_DAYS}-day trial runs before the first
            charge, so cancelling before it ends means you are never charged; cancelling after that
            stops the renewal, and your library stays readable, searchable, and exportable on the
            free plan either way; and if we stop offering the paid plan for reasons within our
            control, our <PageLink href="/terms">Terms</PageLink> commit us to cancelling
            subscriptions and refunding the unused part of any period already paid for. Refunds in
            the ordinary case are <HashLink id="refunds">further down</HashLink>.
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
            You keep it, and you keep using it. The whole library stays readable, searchable, and
            exportable on the free plan, and you can still edit, tag, and delete anything in it —
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
            A preview takes a moment to arrive. The browser extension tries to fill one in whenever
            you save a tab. The mobile apps fetch on the device: the default covers links saved
            there, and setting Link previews to All links also fills in synced and imported links as
            they come into view. With All links selected, Generate all works through everything
            still pending. In the web app, the browser won’t let a web page fetch another site, so
            the opt-in {PLAN_LABELS.plus} preview server fills in new saves and pending links as you
            browse; its Generate all button covers the full library. Some pages give nothing up
            whichever path asks, and no plan changes that: anything behind a login or a paywall, a
            PDF or another file that isn’t a web page, a site that turns away automated requests,
            and pages whose text is assembled by JavaScript after they load. We stop retrying those,
            so they land in the failed count under Link previews in Settings rather than a queue
            that is still working on them. The link is saved either way, and you can give it a title
            of your own.
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
        // THE ONE-DEVICE HALF of the same fact — an edit you regret, with no
        // second device in it — is `undo-edit` below, which carries Trash and the
        // export backstop. This answer links there; that one does not link back.
        // A reader here has just been told an edit can be lost and wants the way
        // out, whereas one who arrived at `undo-edit` by asking about undo has
        // their answer without the sync story.
        //
        // "NOTHING READABLE FROM YOUR LINKS", never "nothing readable at our
        // end" — which is what this answer said until it was read against the
        // schema. The bare form is "the server sees nothing" in a quieter voice:
        // `bracemark-api` is ONE Worker over a username directory, an accounts
        // shard, a sessions DB, a purchases table and R2 (wrangler.jsonc), so a
        // great deal at our end is readable and only the LIBRARY is not. Naming
        // the scope inside the noun phrase is what makes it true — a trailing
        // "…to merge" restricts it too, but a reader takes the noun phrase as
        // the claim and the rest as elaboration. The three sibling surfaces (the
        // landing band's `One link, two devices`, /about's `No version history`,
        // `undo-edit` below) are spelled the same way, and /privacy's "nothing
        // readable from a link" is the form they all follow.
        //
        // NOT MENTIONED, DELIBERATELY: R2 conditional writes (`If-Match` on the
        // etag) are the designed upgrade and are deferred, and the true-conflict
        // winner (local-wins vs server-wins) is an open product call. Neither is a
        // thing that ships, so neither belongs on a page whose rule is only what
        // ships — and "we plan to fix this" is the answer a sync-burned reader
        // trusts least of all.
        //
        // "LIVE IN A SEPARATE ENCRYPTED FILE", never the agentless "are kept in
        // a separate file". A retention verb with no subject leaves the slot for
        // the reader to fill, and here they fill it with US — in the one clause
        // of this answer about the one facet a server of ours may actually have
        // fetched, two sentences after "we hold nothing readable from your
        // links". `extractions/{id}.enc` is the reader's own encrypted file
        // (docs/local-first-sync.md, _the file layout_); saying `encrypted` is
        // what settles whose it is, since the surrounding answer has already
        // established that as the shape of their own library. Same repair as
        // /extractor's "the person who asked keeps what comes back".
        id: 'two-devices',
        q: 'What happens if I change the same link on two devices?',
        a: (
          <>
            Each link, list and tag is stored as its own encrypted file, so two devices working on
            different things never collide. If the same link is edited in both places before they
            sync, the later edit is the one that survives and the earlier one is replaced — we hold
            nothing readable from your links, so there is no merge we could do for you and no older
            version to restore (see <HashLink id="undo-edit">can I undo a change</HashLink>).
            Anything you change offline queues up and goes out in order the next time you have a
            network. Titles and preview images fetched in the background live in a separate
            encrypted file from what you write, so one never overwrites the other.
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
        // The ONE-DEVICE half of `two-devices` above. The no-version-history fact
        // already reaches three surfaces — /about's `No version history` trade
        // row, the landing band's `One link, two devices`, and `two-devices`
        // here — and all three state it as a CONFLICT, which a reader with one
        // device never has. What they type is this question, and it wants a
        // different answer, because the two halves come apart:
        //
        // REMOVING IS REVERSIBLE AND EDITING IS NOT. Remove is
        // `update({ listId: TRASH_ID })` with **Restore** and **Delete
        // permanently** waiting in the Trash view (docs/editors.md, the bulk
        // toolbar); an edit re-puts `links/{id}.enc` over itself and there is
        // nothing readable from your links to have kept the old one in. Do not blur
        // the two into a single "we cannot recover things" line — the
        // recoverable half is the good news, and it is what the reader came for.
        //
        // RESTORE LANDS IN My List, not in the list the link came from: the
        // schema records no previous list (docs/editors.md). Said out loud,
        // because a reader expecting the old list back and getting the inbox
        // reads it as a second loss.
        //
        // NO PURGE WINDOW IS PROMISED, because none ships. system-lists.ts calls
        // Trash "the deletion staging area (links pending the purge window)", but
        // nothing in the repo purges anything on a timer — Trash holds until the
        // user empties it by hand. A "for 30 days" here would be inventing a
        // feature, and it is the kind a reader plans around.
        //
        // ⚠ THE EXPORT BACKSTOP IS NOT AN UNDO FOR THE EDIT THIS ANSWER IS
        // ABOUT, and "the full backup restores everything" said it was. The
        // bracemark import merges SKIP-EXISTING BY PATH (`import-all-data.ts`,
        // POLICY): a path already in the local store is never touched, so
        // restoring into the same account cannot put an old title back —
        // `links/{id}.enc` is still there and the line is skipped. The
        // deletion half DOES work, because `destroy` removes the path and its
        // satellites (`use-link-mutations.ts`), which is why "before a big
        // clean-up" was the true part of the old sentence. Sitting one clause
        // after "an edit is the half we cannot help with", the adjective read
        // as the way out of exactly the case it does not cover — a reader
        // takes a backup believing a retitle is now reversible, and finds out
        // when it matters. The mechanism is stated instead, and it is short
        // enough to be worth the words: fills gaps, never overwrites.
        //
        // "TRASH" AND "My List" ARE DEFAULT LABELS, not fixed names. Both are
        // real lists the user can rename, and `SYSTEM_LIST_NAMES`
        // (`shared/src/sync/system-lists.ts`) graduates to the translation layer
        // when i18n arrives — at which point an untouched list localizes and this
        // sentence does not follow it. Named anyway: the in-app word is what
        // makes the answer actionable, and this file already spells "Settings →
        // Data" and the layout setting the same way. That file is where a rename
        // would start, and nothing links it to this line.
        id: 'undo-edit',
        q: 'Can I undo a change, or get a deleted link back?',
        a: (
          <>
            A deleted link, yes: removing a link puts it in Trash, and it stays there until you
            delete it permanently. Restore brings it back — to My List, since nothing records which
            list it came from. An edit is the half we cannot help with. Saving a title, a note or a
            set of tags replaces what was there, and we hold nothing readable from your links to
            have kept the earlier version in, so there is no history to roll back through and
            nothing we could hand you. An export is the backstop worth having, with one thing to
            know about it: restoring a backup fills gaps rather than overwriting, so a link you
            deleted comes back and a link you still have keeps the version on your device. It covers
            the clean-up you regret rather than the edit, and exporting first costs nothing.
          </>
        ),
      },
      {
        // THE ONLY SURFACE THAT ENUMERATES THE EXPORT FORMATS, and it holds that
        // job on purpose. `ExportFormat` is `'bracemark' | 'netscape' | 'csv' |
        // 'text'`, declared in `web-react/src/data/export-all-data.ts` and again
        // in `expo-react/src/data/export-all-data.ts`; `bracemark-site` depends
        // on neither, importing `shared` and nothing else. Nothing therefore
        // links this sentence to the union — a fifth format leaves it quietly
        // wrong with no lint error, type error or failing test, the same shape
        // as the /extractor caps. The landing page used to carry the count twice
        // and now carries it nowhere (DURABILITY names the archive's bytes and
        // says "Formats other apps read are there too"; the LIBRARY bullet says
        // "Several formats"), so a new format is a one-line edit HERE and only
        // here. Keep it that way rather than re-seeding a number upstream.
        //
        // THE LOCKED-LIST EXCEPTION IS STATED HERE AND ONLY HERE. The export
        // policy excludes a locked list with its links, pins, extractions and
        // files, and the list entity too — a hidden list's NAME is as sensitive
        // as its contents (`export-all-data.ts`, POLICY, both platforms). So
        // "the whole library" is an absolute the one reader who cares can
        // disprove from their own screen: the receipt they get says "2 locked
        // lists were not included". The condition is theirs and one unlock
        // away, which is why it is a clause rather than a caveat paragraph, and
        // why `free-cap` and `stop-paying` do NOT repeat it — those answers are
        // about the free/paid boundary, and a fact stated on three surfaces is
        // a fact that drifts on two of them. /privacy's portability bullet is
        // the deliberate second copy: it answers a legal right, where an
        // unstated omission costs more.
        //
        // The CSV columns are the shipped header, not a paraphrase:
        // `shared/src/export/csv.ts` writes `url, folder, title, note, tags,
        // created`, which is Raindrop's documented import order — "the address,
        // list, title, note, tags, and date" is that row in the reader's words.
        // The landing page deliberately does NOT carry the row shape; DURABILITY
        // states the archive once and this answer carries the columns.
        //
        // "NEVER UPLOADED" CANNOT STAND ALONE, and it stood alone here for
        // several releases. It is true of the FILE — import is client-only on
        // both platforms (`web-react/src/data/import-all-data.ts` parses and
        // writes through the local write edge; docs/data-lifecycle.md, the
        // header: "the only server traffic is the ordinary sync plane") — and
        // the reader takes it as a claim about the IMPORT, which then reads as
        // a promise that nothing goes up at all. `e2e` above uses the same verb
        // for the path everything actually takes ("encryption happens before
        // anything is uploaded"), so the two answers contradicted each other on
        // the word, and the one a switcher can falsify from their own second
        // device was this one. The scope is now in the noun (the file) and the
        // sequel is stated rather than left to be inferred — same repair as
        // "nothing readable from your links" in `two-devices`. The reassurance
        // is kept rather than dropped: a bookmarks export is the reader's whole
        // browsing history, and nowhere else on the property says we do not
        // ship that file to a parser. `import-over-cap` above owns the other
        // half ("counted before anything is saved", "the file on your device is
        // never changed") and deliberately makes no upload claim — one surface
        // per fact.
        //
        // RAINDROP'S HTML, NOT ITS CSV. Both import, and the in-app Import
        // description says so; this answer and the landing page's Import card
        // name only the HTML export, because it is the one to bring. The CSV
        // joins nested collections with " / " and writes each name as-is, so a
        // collection called "Work / Clients" comes back as two lists, and
        // nothing in that file can say otherwise (docs/data-lifecycle.md,
        // _importing from Raindrop.io_). The example is a name a real person
        // would type, not the separator spelled out, which reads as noise.
        id: 'import-export',
        q: 'Can I bring my bookmarks in, and take them out again?',
        a: (
          <>
            Both. Import a browser bookmarks export, a Raindrop HTML export, or a plain list of URLs
            — the file is read on your device and never sent anywhere; the links it holds sync
            encrypted, like every other link. From Raindrop, the HTML export is the one to use: its
            CSV turns a collection named “Work / Clients” into a Clients list inside a Work list. If
            the file holds more links than your plan has room for, you are asked before anything is
            saved (see{' '}
            <HashLink id="import-over-cap">what if I import more than {FREE_LINKS} links</HashLink>
            ). Export gives you the whole library on every plan: a full backup that restores
            everything, or one of three formats other apps read — a browser bookmarks file, a CSV
            carrying the address, list, title, note, tags, and date of every link, and a plain list
            of URLs. A list you have locked is left out of the file until you unlock it.
          </>
        ),
      },
      {
        // "How do I delete everything?" was the question until the username
        // answered it: the handle is tombstoned at teardown and occupied
        // forever, so "everything" is the one word this answer cannot support
        // (docs/data-lifecycle.md, _what's deliberately kept_ — the purchases
        // row and /privacy's tax-law retention are two more). The heading now
        // names the two actions instead, which is also the pair a reader is
        // choosing between, and the retirement is stated here rather than left
        // to /terms — a reader told "everything" who later finds their name
        // taken learns we round up.
        //
        // DELETE ACCOUNT IS A SUPERSET, and the answer has to say so, because the
        // half it used to name for that branch was the KEYS ("the keys that could
        // ever have opened it") and a reader completes the other half
        // themselves — wrongly. Read against the Data branch beside it, naming
        // only the cryptographic kill says the ciphertext survives unreadable,
        // and the careful reader's conclusion is that the safe order is Data
        // first, Account second. It is one call: `deleteAccount`
        // (`bracemark-api/src/services/account.ts`) opens its teardown with the
        // SAME `deleteAllUserData` that Settings → Data's endpoint calls
        // (`routes/data.ts`) — DO op log + quota map, then every R2 object under
        // the user's prefix — and only then tombstones, drops the doors and the
        // user row, and revokes the sessions (docs/data-lifecycle.md, the header
        // table: "wiped (same service)"). If that ordering ever changes, this
        // answer is wrong rather than stale.
        //
        // Both halves are stated because bytes-gone AND keys-gone is a stronger
        // claim than either alone, and the sequence is the mechanism the rest of
        // this property argues from. "ALONG WITH THE KEYS", never "also
        // destroying" or "including destroying": the doors are a CO-OBJECT of the
        // delete, dropped in the same D1 batch as the user row
        // (`accountKeysRepo(shard).deleteAllByUserIdStmt` beside
        // `usersRepo(shard).deleteStmt`). "Also" makes them a third step a reader
        // then wonders whether they must run, which is the counting error this
        // answer exists to stop; "including" opens a set the sentence never
        // closes. It does NOT widen into what teardown keeps
        // beyond the username — the purchases row and /privacy's tax-law
        // retention stay where they are, per the note above.
        id: 'delete-account',
        q: 'How do I delete my library, or my whole account?',
        a: (
          <>
            Settings → Data wipes your library and keeps the account. Settings → Account does that
            same wipe and then deletes the account itself, along with the keys that could ever have
            opened it — so there is no need to run both. Neither can be undone, so both ask you to
            confirm first. Your username is the one thing that stays: it is retired rather than
            released, so nobody can register it later and be mistaken for you.
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
//
// `monthly` earns its place the same way, off a different number: the Plus card's
// price note reads "$4 a month, billed annually", and that qualifier is there
// precisely because there is no monthly plan — so the page raises the question in
// three words and, without this id, answered it nowhere. The answer's own note
// says it is written to be read "with a card in hand"; this is that surface.
//
// Read in pairs, which is how the two-column grid on /pricing renders them: the
// free tier and its cap, then how you buy, then how you stop. That is the order a
// buyer moves through, and it survives a plan being added because none of the six
// is about a specific plan.
export const PRICING_FAQ_IDS = [
  'free-cap',
  'import-over-cap',
  'trial',
  'monthly',
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
