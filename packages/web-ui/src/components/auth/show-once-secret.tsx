'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { cn } from '@stxapps/web-ui/lib/utils';

// The wallet-style "show it once" panel for a recovery code (docs/account.md —
// "present it like a wallet seed"): the secret in a monospace box, a Copy button, and,
// where something is still to come, an "I've saved this" checkbox that gates it. There
// is no server-side recovery, so this is the only moment the code exists in a form the
// user can save.
//
// THE CHECKBOX IS OPTIONAL, and only one caller passes it. Create-account's recovery
// step gates its Continue on it, because nothing is committed yet and the step offers
// a way on without a code. Settings → recovery code shows a code that is ALREADY live
// when this renders: a tick before "Done" read there as the thing that would make it
// count, and leaving without saving costs only a fresh mint, so it has none.
//
// THE ORDER IS THE SCRIPT, one action per row, top to bottom: read the secret →
// settle on it (`actions`) → copy it → confirm you saved it → continue. Copy is
// full-width rather than an icon button beside the box, because on this panel it
// is not a convenience on a field — it IS the step. The panel's whole purpose is
// getting the secret into a password manager, and an unlabelled 36px glyph is the
// weakest affordance in the kit for the most consequential action on the screen.
// Full width also gives the state change somewhere to say itself in words
// ("Copied") instead of only in an aria-label. It stays `variant="outline"` so it
// can't compete with the step's solid primary button, and something always sits
// between the two so they never stack edge to edge: the bordered checkbox card, or on
// Settings, which has none, the line saying the code is shown only once.
//
// SETTLE BEFORE COMMIT is why `actions` renders ABOVE Copy rather than below it.
// Regenerate silently invalidates a copy that has already been taken — the
// clipboard would still hold the old secret with nothing on screen to say so — so
// the controls that change WHICH secret you get are placed before the control
// that acts on it, and the reset below covers whoever does it anyway.
export function ShowOnceSecret({
  secret,
  label,
  confirm,
  actions,
  className,
}: {
  secret: string;
  // Screen-reader label for the secret box (e.g. "Your recovery code").
  label: string;
  // The "I've saved it" checkbox: all three, or none of them.
  confirm?: {
    id: string;
    saved: boolean;
    onSavedChange: (saved: boolean) => void;
    // Text beside the checkbox.
    label: string;
  };
  // Controls that change which secret is on screen — create-account's Regenerate.
  // Rendered between the secret and Copy, so they read as belonging to the
  // value above them rather than to the confirmation below. Omit where there is
  // nothing to settle (the secret is already minted and final).
  actions?: React.ReactNode;
  className?: string;
}) {
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

      <CopySecretButton secret={secret} />

      {confirm ? (
        <Label
          htmlFor={confirm.id}
          className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
        >
          <Checkbox
            id={confirm.id}
            checked={confirm.saved}
            onCheckedChange={(v) => confirm.onSavedChange(v === true)}
            className="mt-0.5"
          />
          <span>{confirm.label}</span>
        </Label>
      ) : null}
    </div>
  );
}

// The copy itself and its "Copied" flash, shared by the two ways Copy is drawn.
function useCopySecret(secret: string) {
  const [copied, setCopied] = React.useState(false);
  const revertTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = null;
  };

  // A new secret invalidates "Copied". Regenerate is never more than a row away
  // from Copy (above it on the panel, beside it on create-account's step one), so
  // without the reset the affordance would go on claiming that a password no longer
  // on screen — and no longer the one that will be used — had been saved. Doubles
  // as the unmount cleanup for the revert timer.
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

  return { copied, copy };
}

// Full-width and labelled, because on this panel Copy is not a convenience on a
// field: it IS the step.
export function CopySecretButton({ secret }: { secret: string }) {
  const { copied, copy } = useCopySecret(secret);

  // No `data-icon="inline-start"` on the glyph, deliberately: that marker trims the
  // padding on the edge an icon hugs, and in a w-full button the content is centred,
  // with no edge to hug. See button.tsx's header.
  return (
    <Button type="button" variant="outline" onClick={copy} className="w-full">
      {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// The quiet text-button look for an action ON a secret rather than the step itself:
// every Copy and Regenerate in create-account is drawn with it, so they can't drift
// apart. The `after:` is the target (docs/accessibility.md, _a web target on a touch
// screen_), and its HEIGHT is the caller's, because it is set by what sits above and
// below: never more than half the gap to a pressable neighbour. SECRET_TEXT_SLOP_Y is
// the value with nothing nearer than 24px either way.
export const SECRET_TEXT_ACTION =
  'relative inline-flex items-center gap-1.5 text-sm text-muted-foreground after:absolute after:-inset-x-2 hover:text-foreground';
// 12px each way takes a 20px line to 44.
export const SECRET_TEXT_SLOP_Y = 'after:-inset-y-3';

// Copy drawn as SECRET_TEXT_ACTION, for create-account's step one, where the browser's
// own save is the main path and Copy is the fallback (docs/account.md, _creating an
// account_). The check is tinted, as on the full-width button: as grey text, the
// glyph is the only thing besides the word that says the copy happened.
export function CopySecretTextButton({ secret }: { secret: string }) {
  const { copied, copy } = useCopySecret(secret);
  return (
    <button type="button" onClick={copy} className={cn(SECRET_TEXT_ACTION, SECRET_TEXT_SLOP_Y)}>
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
