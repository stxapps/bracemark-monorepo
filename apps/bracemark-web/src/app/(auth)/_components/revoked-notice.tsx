'use client';

import { LogOut } from 'lucide-react';

import { SESSION_COPY } from '@stxapps/react';
import { useAuth } from '@stxapps/web-react';

// Why this sign-in screen is here, when the server told this device to forget
// (`session_revoked` — sign out other devices, or the account deleted elsewhere):
// the local copy is gone, and the user should hear that from us rather than find
// an empty library after signing back in. docs/sessions.md.
//
// A BLOCK, not a line. It was a muted `text-sm` paragraph, the same grey as every
// standing caption on these cards, and the browser extension's twin — same
// styling at its own scale — was read past by someone who knows the screen
// well: it looked like part of the page, not news. So it takes the paused
// notice's shape (components/sync-paused-notice.tsx: a bordered `bg-muted/40`
// block with an icon) with the words in the foreground colour. Grey, not a
// tone: it asks for nothing but the form under it. The twins are the browser
// extension's popup/SignIn.tsx and bracemark-expo's features/auth/revoked-notice.tsx.
//
// The reason lives in the auth provider's memory only, so a reload drops it. A
// polite status: it arrives as the result of a server verdict, not of anything
// the user just did (docs/accessibility.md, _what must NOT announce_).
export function RevokedNotice() {
  const { reason } = useAuth();
  if (reason !== 'revoked') return null;
  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm"
    >
      <LogOut aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p>{SESSION_COPY.revoked}</p>
    </div>
  );
}
