'use client';

import { CopySecretButton } from '@stxapps/web-ui/components/auth/copy-secret-button';
import { cn } from '@stxapps/web-ui/lib/utils';

// The wallet-style "show it once" panel for a recovery code (docs/account.md —
// "present it like a wallet seed"): the secret in a monospace box and a full-width
// Copy under it (copy-secret-button.tsx, which carries the argument for full width).
// There is no server-side recovery, so this is the only moment the code exists in a
// form the user can save. Both places that show one — the welcome after
// create-account and Settings → recovery code — show a code that is ALREADY live, so
// there is no "I've saved this" checkbox: a tick before "Continue" or "Done" read as
// the thing that would make it count, and leaving without saving costs only a fresh
// mint (docs/account.md, _a recovery code in Settings_).
export function ShowOnceSecret({
  secret,
  label,
  className,
}: {
  secret: string;
  // Screen-reader label for the secret box (e.g. "Your recovery code").
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* `<output>` carries an implicit `role="status"`, so the code arriving is
          announced to a screen reader without an aria-live of our own. */}
      <output
        aria-label={label}
        className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
      >
        {secret}
      </output>

      <CopySecretButton secret={secret} />
    </div>
  );
}
