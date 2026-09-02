// The words every public listing says about Bracemark, and the character budget
// each store gives them. Sibling of listings.ts, which holds the URLs those
// listings live at — same argument for being here, one level up: the copy has to
// agree with itself across five consoles and three repos-worth of surfaces, and
// nothing enforces that agreement except keeping it in one file.
//
// The BRAND lines, COMPANY and SOURCE are NOT here — they are in ../brand/brand.ts.
// They are read by Settings → About, the marketing site and the app chrome, and a
// store listing is only one of their consumers; they sat in this file (under a
// folder named `stores/`) for longer than that was true.
//
// This module has TWO kinds of export and they are used completely differently:
//
//   - IMPORTED BY CODE. `BROWSER_EXTENSION_LISTING` is read at build time by the
//     browser extension's wxt.config.ts, which writes it into manifest.json. If it
//     drifts, it drifts silently and ships.
//   - PASTED BY A HUMAN, once per submission, into App Store Connect and the Play
//     Console. Nothing imports them. They live here anyway because they are the
//     same product argument as the strings above, and the failure mode is real:
//     the browser extension manifest carried Brace.to v1's "technology that
//     empowers you to truly own your account and data" through the entire rename
//     because no one had a reason to open that file.
//
// THE COPY RULE, inherited from apps/bracemark-site/src/app/page.tsx: only promise
// what ships. Read mode, screenshots, page copies and AI are planned, not shipped,
// so none of them appears here.
//
// ITS SIBLING, AND THE ONE THAT BIT: no claim about the server may read as
// EXHAUSTIVE unless it is. "Our servers hold a path, a size, and bytes we have no
// key for" was true of the LIBRARY and false as a sentence about the servers,
// which is how it was written — the same host holds a username, a public key,
// sessions and a subscription row in the clear (apps/bracemark-api/wrangler.jsonc),
// and `bracemark-extractor` is handed a plaintext URL by construction when the
// opt-in setting is on. Both strings below now scope the claim ("of your library")
// and name what is readable, which is the phrasing /privacy and the landing page
// already use. The failure mode is worth restating because it is invisible here in
// a way it is nowhere else: this copy is pasted into a console, so a store
// description cannot be corrected without shipping a build through review.
//
// NO NUMBERS, deliberately — no free-plan cap, no price, no trial length. The site
// reads those from `iap/plans` so they cannot go stale, but a store description
// can only be changed by shipping a build through review, so an interpolated
// number would be correct in the repo and wrong on the storefront for as long as
// review takes. The App Store's promotional text is the field for numbers: Apple
// lets it change WITHOUT a review, which is exactly why it is separate from the
// description.

import { BRAND } from '../brand/brand';

// --- what the stores allow ---------------------------------------------------
// Every limit below is a SILENT constraint until submission day, when a 31-character
// subtitle is rejected by a console months after someone wrote it. listing-copy.spec.ts
// asserts every string in this file against its budget, so the failure lands in
// `npx nx test @stxapps/shared` instead.
//
// Re-verify in the consoles at submission — Apple in particular moves these.
//
// `indexed` records whether a field feeds the store's SEARCH, because it decides
// where the keywords go and the two stores disagree completely:
//   - Apple indexes name + subtitle + the keyword field, and NOT the description.
//   - Google indexes title + short description + full description, and has no
//     keyword field at all.
// That is why FULL_DESCRIPTION carries its search terms in ordinary prose (Google
// reads it) while APP_STORE.keywords exists as a bare comma list (Apple reads it,
// no human ever does).
export const STORE_LIMITS = {
  appStore: { name: 30, subtitle: 30, keywords: 100, promotionalText: 170, description: 4000 },
  play: { title: 30, shortDescription: 80, fullDescription: 4000 },
  /** One manifest serves both browsers, so each budget is the smaller of the two. */
  browserExtension: { name: 45, description: 132 },
  firefoxAddons: { summary: 250 },
} as const;

// --- the App Store -----------------------------------------------------------
//
// `name` is the LISTING name in App Store Connect. It is NOT the same string as
// `name` in apps/bracemark-expo/app.config.ts, which is the home-screen label and
// should stay the bare word "Bracemark" — a home screen has no room for a
// descriptor and no search to be found by. Wiring the two together looks like
// tidying and would put "Bracemark: Private Bookmarks" under the icon on every
// device. Same trap on the Play side with `android.package`'s app label.
//
// Shipping the bare word "Bracemark" as the listing name instead would be the
// bigger mistake: it spends 21 of 30 indexed characters on a brand nobody is
// searching for yet.
export const APP_STORE = {
  name: 'Bracemark: Private Bookmarks',
  subtitle: BRAND.subtitle,

  /**
   * Apple's keyword field — invisible to users, pure search index. Comma-separated
   * with NO spaces (a space is an indexed character), singular forms only, and
   * never a word already in `name` or `subtitle`: Apple indexes those separately,
   * so "private", "bookmarks" and "read" here would be wasted budget.
   *
   * No competitor names. "pocket", "raindrop" and "pinboard" are the obvious
   * additions and all three are trademarks — Apple rejects the build for it
   * (guideline 2.3.7) rather than just dropping the term.
   */
  keywords:
    'zero,knowledge,encrypted,e2ee,secure,vault,later,save,link,url,tab,offline,sync,manager',

  /**
   * The one field Apple lets us change without a review, which makes it the only
   * safe home for anything time-bound — a price, a trial length, a launch note.
   * Shown above the description, and not indexed.
   */
  promotionalText:
    'Pick a username, save the password we generate for you, and save your first link a minute later. No email address, because the account has nowhere to put one.',
} as const;

// --- Google Play -------------------------------------------------------------
export const PLAY = {
  title: APP_STORE.name,

  /** Indexed, and the only copy most visitors read. */
  shortDescription: 'Bookmarks only you can read. Encrypted on your device before they ever sync.',
} as const;

// --- the long description, for both stores -----------------------------------
//
// ONE description, not two. Apple does not index it and Google does, so the
// temptation is a keyword-tuned Play variant — but two long descriptions is two
// things to keep true, and the accuracy of this text is load-bearing for a product
// whose entire claim is that it does not lie about what the server holds. Written
// to carry its search terms in ordinary prose instead.
//
// DO NOT name other mobile platforms here. "on iPhone, iPad and Android" is the
// natural line to add and Apple rejects it (guideline 2.3.10, metadata referencing
// other mobile platforms). Browsers are fine — "Chrome and Firefox" below is not a
// platform reference.
//
// "Browser extension", never bare "extension" (docs/architecture.md — _naming_):
// bracemark-expo ships an iOS share extension, which is a different thing. The
// distinction matters more here than anywhere, because a store listing is read by
// people who have no idea either exists.
export const FULL_DESCRIPTION = `Bracemark is a bookmark manager that cannot read your bookmarks.

Save anything worth coming back to — articles, docs, threads, products, videos — and read it later on any device.

Every link you save is encrypted on your device before it syncs: the address, the title, the tags, the list you filed it in. Your key is derived from your password, on your device, and never leaves it. Of your library, our servers hold a path, a size, and bytes we have no key for; the account around it — your username, your plan — is what we can read.

That is not a privacy policy. It is the architecture. We cannot look, so we cannot be asked to.

SAVING A LINK
• Share into Bracemark from any app — a browser, a podcast player, a social app
• Save the tab you’re reading with the browser extension on Chrome and Firefox
• Paste a URL into the web app
• Import a browser bookmarks export, a CSV, or a plain list of URLs

FINDING IT AGAIN
• Lists and tags, so a link is where you would look for it
• Pins for the handful you are working from right now
• Search across titles, addresses and hosts, instantly, on your device
• Card or list layouts, set per device
• Previews with titles and images, pulled by the device that saved the link
• The whole library lives on the device, so it opens and searches offline

YOURS TO LEAVE WITH
• Full export in open formats, on every plan, forever
• No ads, no trackers, no analytics — the only outside code we load runs the checkout
• No email address required — sign up with a username

WHAT IT COSTS TO BUILD IT THIS WAY
We hold no key, so there is no password reset. A recovery code is your second door, and saving it is genuinely on you. Search runs on your device rather than ours. There are no shared or public lists.

Bracemark is paid for by subscriptions. There is no advertising, no data to sell, and no investor waiting for us to change that.`;

// --- the browser extension ---------------------------------------------------
//
// These two are IMPORTED, not pasted: wxt.config.ts writes them into manifest.json,
// and both stores read the listing's title and summary straight out of the manifest.
// Editing the listing therefore means editing this file and shipping a build.
//
// Sold on the gesture rather than the architecture. Someone browsing the Web Store
// has already decided they want to save tabs; what they are choosing between is how
// many clicks it takes.
//
// Which is why the number has to be the real one. This said "in one click" and the
// extension has never had a one-click path: the toolbar action opens the popup and
// `entrypoints/popup/Editor.tsx` requires an explicit Save, with no `commands`,
// `contextMenus` or `action.onClicked` shortcut past it. Nothing here could catch
// that — the budget spec measures length, not truth, and this file cannot see
// bracemark-extension — and it is the single easiest claim we make to falsify,
// since the reader disproves it on their own toolbar the minute after installing.
// Two is still a good number to be sold on. Walk the popup before changing it back.
export const BROWSER_EXTENSION_LISTING = {
  name: APP_STORE.name,
  description:
    'Save the tab you’re reading in two clicks. Bracemark encrypts every link in your browser before it syncs — only you can read it.',
} as const;

/**
 * Firefox Add-ons takes a longer summary than the Chrome Web Store, and AMO lets
 * it be set on the listing rather than in the manifest — so this is a paste field,
 * and the manifest keeps the shorter string above for both browsers.
 */
export const FIREFOX_ADDONS_SUMMARY = `${BRAND.tagline}. Save the tab you’re reading in two clicks, encrypted in your browser with a key derived from your password before it syncs. Of your library we hold a path, a size, and bytes we have no key for.`;
