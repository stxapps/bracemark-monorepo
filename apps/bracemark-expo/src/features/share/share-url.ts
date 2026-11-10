// Normalizing what the OS hands the share sheet into one `{ url, title }`
// payload — pure, so it's spec-able (the native halves aren't). Two shapes
// arrive here (docs/share-sheet.md):
//
//  - iOS (ShareViewController's initial props): `url` for a URL attachment,
//    `text` for a text attachment, and `preprocessingResults` from our
//    preprocessing.js (`{ title, url, readMode }` captured in Safari's page
//    context — the only place a page title exists without fetching).
//  - Android (ShareActivity launch options): `text` (EXTRA_TEXT — Chrome
//    sometimes wraps the URL in prose) and `subject` (EXTRA_SUBJECT — often
//    the page title).
//
// A null url is a SOFT result, like shared's normalizeUrl: the sheet shows
// "no link found" rather than crashing.

import { normalizeUrl } from '@stxapps/shared';

// What both native hosts hand the RN root, unioned.
export interface ShareInitialProps {
  url?: string;
  text?: string;
  subject?: string;
  preprocessingResults?: unknown;
}

export interface SharePayload {
  url: string | null;
  title?: string;
  // The page's read-mode copy, when Safari's preprocessing found an article
  // (share-extension/preprocessing.js) — a `ReaderDoc` as JSON TEXT, and it stays
  // text all the way to the app's drain. Never parsed here: the sheet only writes
  // it to the draft, and an article as an object graph is memory the iOS share
  // extension does not have (docs/share-sheet.md, _what the sheet does and
  // doesn't do_). The app parses and validates it where it stores it (expo-react
  // store-read-mode.ts).
  readMode?: string;
}

const URL_IN_TEXT_RE = /https?:\/\/\S+/i;

// The first http(s) URL inside a shared text, else the whole text if it IS a
// URL (normalizeUrl prepends the scheme for dotted hosts, rejects prose).
export function urlFromSharedText(text: string | undefined): string | null {
  if (!text) return null;
  const match = URL_IN_TEXT_RE.exec(text);
  return normalizeUrl(match ? match[0] : text);
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function payloadFromInitialProps(props: ShareInitialProps): SharePayload {
  // Our preprocessing.js output — untrusted shape (a stale build, a non-Safari
  // host that never ran it), so field-check rather than assert.
  const pre =
    props.preprocessingResults && typeof props.preprocessingResults === 'object'
      ? (props.preprocessingResults as { title?: unknown; url?: unknown; readMode?: unknown })
      : {};

  // The URL attachment is the most deliberate source; the page's own location
  // (preprocessing) next; last, fish it out of the shared text.
  const url =
    (cleanText(props.url) !== undefined ? normalizeUrl(props.url as string) : null) ??
    (cleanText(pre.url) !== undefined ? normalizeUrl(pre.url as string) : null) ??
    urlFromSharedText(props.text);

  const title = cleanText(pre.title) ?? cleanText(props.subject);
  // Text or nothing. An OBJECT here is a preprocessing.js older than this bundle
  // (a dev build's JS reloaded ahead of a native rebuild — the two ship together
  // otherwise), and it is dropped rather than carried: the copy is optional, the
  // memory is not.
  const readMode =
    typeof pre.readMode === 'string' && pre.readMode !== '' ? pre.readMode : undefined;
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(readMode !== undefined ? { readMode } : {}),
  };
}
