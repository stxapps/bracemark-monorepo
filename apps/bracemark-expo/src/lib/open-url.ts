import { Linking } from 'react-native';

import { openableUrl } from '@stxapps/shared';

// Leaving the app for a link's page, in the system browser. Shared by the links rows
// and cards (a press opens the page), the reader and the capture screen (their top
// bar's ⋯ menu) — so it lives here, not in any one of those features.

// A link's page: `openableUrl` (@stxapps/shared url/url.ts), so a confirm-saved
// `host:port` opens over http instead of asking the OS for a scheme no app handles —
// a rejected promise and a press that did nothing. A url nothing can open stays a
// no-op, as on web, where its anchor has no href.
export function openLink(url: string): void {
  const href = openableUrl(url);
  if (href) void Linking.openURL(href).catch(() => undefined);
}

// The Internet Archive's capture of a link's page nearest the day it was saved — the
// reader's and the capture screen's exit for a page that has changed or gone (the row
// menu has none: docs/reader.md, _the way in_). The address is built on the device
// (`waybackUrl`, @stxapps/shared url.ts, which says why nothing may ask the archive
// anything before this press) and opened in the system browser, like the page itself.
export function openWayback(href: string): void {
  void Linking.openURL(href).catch(() => undefined);
}
