'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

// Copy for a secret, in the two ways it is drawn: full-width under the recovery
// code's panel (show-once-secret.tsx) and the new password in Settings, and as quiet
// text on the new-password field (new-password-field.tsx). Both share the copy and
// its "Copied" flash.

// The copy itself and its "Copied" flash, shared by the two ways Copy is drawn.
function useCopySecret(secret: string) {
  const [copied, setCopied] = React.useState(false);
  const revertTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = null;
  };

  // A new secret invalidates "Copied". Regenerate is never more than a row away
  // from Copy wherever a secret can be replaced (beside it on the new-password field), so
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

// Copy is full-width rather than an icon button beside the box, because where it is
// drawn this way it is not a convenience on a field — it IS the step. The panel's
// whole purpose is getting the secret somewhere safe (no password manager offers to
// save a code shown on a page), and an unlabelled 36px glyph is the weakest
// affordance in the kit for the most consequential action on the screen. Full width
// also gives the state change somewhere to say itself in words ("Copied") instead of
// only in an aria-label. It stays `variant="outline"` so it can't compete with the
// screen's solid primary button, and its callers put a line of text or a gap between
// the two.
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
// the new-password field's Copy and Regenerate are drawn with it, so they can't drift
// apart. The `after:` is the target (docs/accessibility.md, _a web target on a touch
// screen_), and its HEIGHT is the caller's, because it is set by what sits above and
// below: never more than half the gap to a pressable neighbour. SECRET_TEXT_SLOP_Y is
// the value with nothing nearer than 24px either way.
export const SECRET_TEXT_ACTION =
  'relative inline-flex items-center gap-1.5 text-sm text-muted-foreground after:absolute after:-inset-x-2 hover:text-foreground';
// 12px each way takes a 20px line to 44.
export const SECRET_TEXT_SLOP_Y = 'after:-inset-y-3';

// Copy drawn as SECRET_TEXT_ACTION, for the new-password field, where the browser's
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
