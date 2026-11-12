import { useState } from 'react';

import { PAYWALL_COPY } from '@stxapps/react';
import { PLAN_LABELS } from '@stxapps/shared';
import { useEntitlements, useSettingMutations, useSettings } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Switch } from '@stxapps/web-ui/components/ui/switch';
import { cn } from '@stxapps/web-ui/lib/utils';

import { OptionsSection } from './Shell';

import { WEB_APP_URL } from '@/utils/web-app-url';

// The browser extension's part of the synced kept-copies setting (`keepReadModeOnSave`
// / `keepScreenshotOnSave`, plus the account-wide `keepReadModeImages`, resolved by
// `keepOnSaveOf` — read mode on, its images off, screenshot off by default), on the one
// client every switch here governs. A save
// here is the save that takes a copy (popup/Editor.tsx, which reads the setting from
// the store at the save), and the saved screen's taps (popup/KeptCopies.tsx) take
// read-mode copies the images switch qualifies. docs/link-extraction-keep.md, _when
// a copy is taken_.
//
// A switch is rendered only where it changes something on the client holding it —
// so bracemark-web's Settings → Read mode keeps only the images switch (that app takes
// no copy on a save, and no screenshot), and expo shows the read-mode-on-save switch
// on iOS alone, for a share from Safari — under its own key, `keepReadModeOnShare`,
// so the read-mode switch here (`keepReadModeOnSave`) governs this extension's saves
// and nothing else (entities.ts says why the two split).
//
// Headed "Keep a copy", the saved screen's own heading for the same two copies, so
// the place you set them reads as the place you take them.
//
// On free: the section's words are PAYWALL_COPY.keptCopies (the upgrade dialog's,
// which this extension has no copy of) and one Upgrade that opens the web app's
// Subscription section — what the saved screen's Plus buttons do. No switches shown
// off and disabled: a disabled switch says nothing about why (docs/accessibility.md).
// The stored value is left alone, so an account that downgrades and comes back keeps
// its choice.
//
// A plain `tabs.create` to the web app, not utils/open-web-app.ts: this page is
// embedded in about:addons, so there is no container to copy (the footer's "Open
// Bracemark" says the same, docs/browser-extension.md).

interface SwitchRowProps {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

// bracemark-web's SettingsRow with a Switch action, class for class — the three
// settings surfaces share one scale (docs/browser-extension.md, _the popup and
// options surfaces_). The Label carries `htmlFor`, which is the Switch's only name.
function SwitchRow({ id, title, description, checked, onCheckedChange }: SwitchRowProps) {
  return (
    <div
      className={cn('flex items-start justify-between gap-4 rounded-lg border border-border p-4')}
    >
      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5')}>
        <Label htmlFor={id} className={cn('text-base font-medium')}>
          {title}
        </Label>
        <span className={cn('text-sm text-muted-foreground')}>{description}</span>
      </div>
      <Switch
        id={id}
        className={cn('shrink-0')}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function CopiesSection({ className }: { className?: string }) {
  const { entitlements } = useEntitlements();
  const { keepOnSave } = useSettings();
  const { setKeepOnSave } = useSettingMutations();
  const [error, setError] = useState<string | null>(null);

  if (!entitlements.keptCopies) {
    const upsell = PAYWALL_COPY.keptCopies;
    return (
      <OptionsSection className={className} title={upsell.title} description={upsell.description}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void browser.tabs.create({ url: `${WEB_APP_URL}/settings/subscription` });
          }}
        >
          Upgrade to {PLAN_LABELS[upsell.plan]}
        </Button>
      </OptionsSection>
    );
  }

  const set = (patch: { readMode?: boolean; readModeImages?: boolean; screenshot?: boolean }) => {
    setError(null);
    void setKeepOnSave(patch).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <OptionsSection
      className={className}
      title="Keep a copy"
      description="A copy keeps what a page held when you saved it, so you can still see it after the page changes, moves or goes behind a sign-in. You can also keep one from the saved screen after you save."
    >
      <div className={cn('flex flex-col gap-3')}>
        <SwitchRow
          id="keep-read-mode"
          title="Keep a read-mode copy when you save"
          description="The page’s article, without ads or menus. A page that isn’t an article keeps none — a screenshot is the copy for those."
          checked={keepOnSave.readMode}
          onCheckedChange={(readMode) => set({ readMode })}
        />
        <SwitchRow
          id="keep-screenshot"
          title="Keep a screenshot when you save"
          description="What was on screen when you saved — the part of the page in view, not all of it."
          checked={keepOnSave.screenshot}
          onCheckedChange={(screenshot) => set({ screenshot })}
        />
        <SwitchRow
          id="keep-read-mode-images"
          title="Include images in read-mode copies"
          description="The article’s pictures, kept with its text in every read-mode copy you keep. They take far more room than the words; with this off, a copy keeps its text only. Copies you have already kept don’t change."
          checked={keepOnSave.readModeImages}
          onCheckedChange={(readModeImages) => set({ readModeImages })}
        />
      </div>
      {error ? (
        <p
          role="alert"
          className={cn('mt-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive')}
        >
          {error}
        </p>
      ) : null}
    </OptionsSection>
  );
}
