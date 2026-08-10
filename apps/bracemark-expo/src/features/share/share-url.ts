// Normalizing what the OS hands the share sheet into one `{ url, title }`
// payload — pure, so it's spec-able (the native halves aren't). Two shapes
// arrive here (docs/share-sheet.md):
//
//  - iOS (expo-share-extension InitialProps): `url` for a URL attachment,
//    `text` for a text attachment, and `preprocessingResults` from our
//    preprocessing.js (`{ title, url }` captured in Safari's page context —
//    the only place a page title exists without fetching).
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
      ? (props.preprocessingResults as { title?: unknown; url?: unknown })
      : {};

  // The URL attachment is the most deliberate source; the page's own location
  // (preprocessing) next; last, fish it out of the shared text.
  const url =
    (cleanText(props.url) !== undefined ? normalizeUrl(props.url as string) : null) ??
    (cleanText(pre.url) !== undefined ? normalizeUrl(pre.url as string) : null) ??
    urlFromSharedText(props.text);

  const title = cleanText(pre.title) ?? cleanText(props.subject);
  return title === undefined ? { url } : { url, title };
}
