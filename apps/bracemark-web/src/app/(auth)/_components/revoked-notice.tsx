'use client';

import { SESSION_COPY } from '@stxapps/react';
import { useAuth } from '@stxapps/web-react';

// Why this sign-in screen is here, when the server told this device to forget
// (`session_revoked` — sign out other devices, or the account deleted elsewhere):
// the local copy is gone, and the user should hear that from us rather than find
// an empty library after signing back in. docs/sessions.md.
//
// The reason lives in the auth provider's memory only, so a reload drops the
// line — by then there is nothing left to explain. A polite status: it arrives as
// the result of a server verdict, not of anything the user just did
// (docs/accessibility.md, _what must NOT announce_).
export function RevokedNotice() {
  const { reason } = useAuth();
  if (reason !== 'revoked') return null;
  return (
    <p role="status" className="mb-6 text-sm text-muted-foreground">
      {SESSION_COPY.revoked}
    </p>
  );
}
