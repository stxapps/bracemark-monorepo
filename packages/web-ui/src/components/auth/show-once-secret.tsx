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
export function ShowOnceSecret({
  secret,
  saved,
  onSavedChange,
  label,
  confirmLabel,
  id,
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
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      // Revert the affordance after a beat so it can be copied again.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions / insecure context): leave the button
      // as-is. The secret is visible, so the user can still select-and-copy.
    }
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-stretch gap-2">
        <output
          aria-label={label}
          className="flex-1 rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm wrap-break-word select-all"
        >
          {secret}
        </output>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy'}
          className="shrink-0 self-start"
        >
          {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
        </Button>
      </div>

      <Label
        htmlFor={id}
        className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm font-normal"
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
