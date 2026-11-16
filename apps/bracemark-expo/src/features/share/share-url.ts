// Normalizing what the OS hands the share sheet into one `{ url, title }`
// payload — pure, so it's spec-able (the native halves aren't). Two shapes
// arrive here (docs/share-sheet.md):
//
//  - iOS (ShareViewController's initial props): `url` for a URL attachment,
//    `text` for a text attachment, and `preprocessingResults` from our
//    preprocessing.js (`{ title, url }` captured in Safari's page
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
  // Where the page's read-mode copy is, when Safari's preprocessing found an
  // article: a file NAME under the App Group's `share/copies/`. The copy itself —
  // a `ReaderDoc` as JSON text, up to 3M characters — never reaches this process's
  // JS: the controller takes it out of the preprocessing results and writes it to
  // that file before the props exist (ShareViewController.swift,
  // `movingReadModeToFile`; docs/share-sheet.md, _what the sheet does and doesn't
  // do_). The sheet carries the name to the draft; the app's drain reads the file.
  readModeFile?: string;
}

// A file name the controller minted — a UUID and `.json`, nothing that could
// climb out of the directory the drain reads it from.
export const READ_MODE_FILE_RE = /^[0-9A-Fa-f-]{36}\.json$/;

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
      ? (props.preprocessingResults as {
          title?: unknown;
          url?: unknown;
          readModeFile?: unknown;
        })
      : {};

  // The URL attachment is the most deliberate source; the page's own location
  // (preprocessing) next; last, fish it out of the shared text.
  const url =
    (cleanText(props.url) !== undefined ? normalizeUrl(props.url as string) : null) ??
    (cleanText(pre.url) !== undefined ? normalizeUrl(pre.url as string) : null) ??
    urlFromSharedText(props.text);

  const title = cleanText(pre.title) ?? cleanText(props.subject);
  // A name or nothing. A `readMode` here — the copy inline, from a controller
  // older than this bundle (a dev build's JS reloaded ahead of a native rebuild) —
  // is ignored: the copy is optional, the memory is not.
  const readModeFile =
    typeof pre.readModeFile === 'string' && READ_MODE_FILE_RE.test(pre.readModeFile)
      ? pre.readModeFile
      : undefined;
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(readModeFile !== undefined ? { readModeFile } : {}),
  };
}
