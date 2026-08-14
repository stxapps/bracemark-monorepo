'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { cn } from '@stxapps/web-ui/lib/utils';

// The wallet-style "show it once" panel shared by the ceremony's generated
// passphrase and the recovery code (docs/account.md — "present it like a wallet
// seed"): the secret in a monospace box, a Copy button, and an "I've saved this"
// checkbox that gates whatever comes next. There is no server-side recovery, so
// this ceremony is the only moment the secret exists in a form the user can save.
//
// THE ORDER IS THE SCRIPT, one action per row, top to bottom: read the secret →
// settle on it (`actions`) → copy it → confirm you saved it → continue. Copy is
// full-width rather than an icon button beside the box, because on this panel it
// is not a convenience on a field — it IS the step. The panel's whole purpose is
// getting the secret into a password manager, and an unlabelled 36px glyph is the
// weakest affordance in the kit for the most consequential action on the screen.
// Full width also gives the state change somewhere to say itself in words
// ("Copied") instead of only in an aria-label. It stays `variant="outline"` so it
// can't compete with the step's solid primary button, and the bordered checkbox
// card always sits between the two so they never stack edge to edge.
//
// SETTLE BEFORE COMMIT is why `actions` renders ABOVE Copy rather than below it.
// Regenerate silently invalidates a copy that has already been taken — the
// clipboard would still hold the old secret with nothing on screen to say so — so
// the controls that change WHICH secret you get are placed before the control
// that acts on it, and the reset below covers whoever does it anyway.
export function ShowOnceSecret({
  secret,
  saved,
  onSavedChange,
  label,
  confirmLabel,
  id,
  actions,
  className,
}: {
  secret: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  // Screen-reader label for the secret box (e.g. "Your passphrase").
  label: string;
  // Text beside the confirm checkbox.
  confirmLabel: string;
  id: string;
  // Controls that change which secret is on screen — Regenerate, "Choose my
  // own". Rendered between the secret and Copy, so they read as belonging to the
  // value above them rather than to the confirmation below. Omit where there is
  // nothing to settle (the secret is already minted and final).
  actions?: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const revertTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = null;
  };

  // A new secret invalidates "Copied". Regenerate sits directly above this
  // button, so without the reset the affordance would go on claiming that a
  // password no longer on screen — and no longer the one that will be used — had
  // been saved. Doubles as the unmount cleanup for the revert timer.
  React.useEffect(() => {
    setCopied(false);
    clearRevert();
    return clearRevert;
  }, [secret]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      // Revert the affordance after a beat so it can be copied again.
      clearRevert();
      revertTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions / insecure context): leave the button
      // as-is. The secret is visible, so the user can still select-and-copy.
    }
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* `<output>` carries an implicit `role="status"`, so regenerating
          announces the new secret to a screen reader without an aria-live of our
          own. Full width now that nothing shares its row. */}
      <output
        aria-label={label}
        className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
      >
        {secret}
      </output>

      {actions}

      {/* No `data-icon="inline-start"` on the glyph, deliberately: that marker
          trims the padding on the edge an icon hugs, and in a w-full button the
          content is centred, with no edge to hug. See button.tsx's header. */}
      <Button type="button" variant="outline" onClick={copy} className="w-full">
        {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>

      <Label
        htmlFor={id}
        className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
      >
        <Checkbox
          id={id}
          checked={saved}
          onCheckedChange={(v) => onSavedChange(v === true)}
          className="mt-0.5"
        />
        <span>{confirmLabel}</span>
      </Label>
    </div>
  );
}
