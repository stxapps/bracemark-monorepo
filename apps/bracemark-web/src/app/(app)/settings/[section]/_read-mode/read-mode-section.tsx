'use client';

import { useState } from 'react';
import Link from 'next/link';

import { PLAN_LABELS } from '@stxapps/shared';
import { useEntitlements, useSettingMutations, useSettings } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Switch } from '@stxapps/web-ui/components/ui/switch';

import {
  SettingsHeader,
  SettingsNotice,
  SettingsPane,
  SettingsRow,
} from '../../_components/settings-kit';

// Settings → Read mode: how the WEB APP takes a read-mode copy — through the
// link-extraction service, `bracemark-extractor`, since a web page can't fetch another site
// (docs/link-extraction-keep.md, _per client_, bracemark-web).
//
// _Server read mode_ is its own synced opt-in, `serverReadMode`, OFF by default — not
// a reading of Link previews' `serverExtraction`. The two consent to different things
// on the same service: previews send every pending link as it comes into view, with
// no gesture; this one only enables the reader's _Keep a read-mode copy_, one link per
// press. Coupled, a single read-mode copy cost the whole un-gestured drain, and Link
// previews' switch stopped being only about previews (entities.ts). The reader's empty
// state offers to turn it on in place (reader-page.tsx); this is the durable surface.
//
// A switch is rendered only where it changes something on the client holding it. So:
//   - _Include images in read-mode copies_ appears only while server read mode is on:
//     off, the web app takes no copy for it to qualify. (It is the synced
//     `keepReadModeImages`, the same field the browser extension's options page and
//     expo show.)
//   - the on-save switches are not here at all — the web app takes no copy on a save
//     and no screenshot. They live on the browser extension's options page
//     (entrypoints/options/CopiesSection.tsx), and a standing line says where.
//
// Its own section rather than a row under Link previews: a preview is a title and an
// image fetched for every link, a copy is the page itself, kept for reading.
//
// On free the section is the header and one upgrade row — Link previews' shape, and
// its title: the free row is named for the switch a paid account sees ("Server
// previews" there, "Server read mode" here). And its words, like Link previews', say
// what the plan adds, not how: no service named here. That name is the disclosure
// a switch rests on, so it sits on the paid switch and the reader's turn-on prompt;
// on an upsell it is a detail of how, not a reason to upgrade.
// Not the switch shown off and disabled: a disabled switch tells a screen reader
// nothing about why (docs/accessibility.md, _a
// `disabled` button says nothing either_). The stored value is left alone, so an
// account that downgrades and comes back keeps its choice.
export function ReadModeSection() {
  const { entitlements } = useEntitlements();
  const { serverReadMode, keepOnSave } = useSettings();
  const { setServerReadMode, setKeepOnSave } = useSettingMutations();
  const [error, setError] = useState<string | null>(null);

  const header = (
    <SettingsHeader
      title="Read mode"
      description="A read-mode copy is the article on a page — its text and images, without the ads and menus — kept with the link, so you can still read it after the page changes, moves or goes behind a sign-in. Open one with Read in a link’s menu."
    />
  );

  if (!entitlements.keptCopies) {
    return (
      <SettingsPane>
        {header}
        <SettingsRow
          title="Server read mode"
          description="Upgrade to keep a read-mode copy of a link right here in the web app, without the browser extension. Copies you have already kept stay readable on every plan."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/subscription">Upgrade to {PLAN_LABELS.plus}</Link>
            </Button>
          }
        />
      </SettingsPane>
    );
  }

  const run = (write: Promise<void>) => {
    setError(null);
    void write.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <SettingsPane>
      {header}

      {/* Labels, not strings: the `htmlFor` pairing is the only thing naming each
          Switch, and both type classes are overridden to match a plain row title
          (link-previews-section.tsx says why at length). */}
      <div className="flex flex-col gap-3">
        {/* The disclosure: why a server is involved, when it is asked, and what it
            gets — the address, not the account, and the IP held briefly. The IP clause
            is a PRIVACY fact, not a limit on the feature: "the rate limiter briefly
            holds…" read as "read mode may pause", so it says what is held and why.
            Without it, "not your account" alone would be the overclaim Link previews'
            switch was corrected for. The service by its one name, "link-extraction
            service" (docs/brand-assets.md, _terminology_) — the name /privacy and
            /extractor use, so the consent here and the policy there match. The
            reader's turn-on prompt says the same words. */}
        <SettingsRow
          title={
            <Label htmlFor="server-read-mode" className="text-base font-medium">
              Server read mode
            </Label>
          }
          description="The web app can’t open other sites, so our link-extraction service fetches the page for you — only when you ask for a read-mode copy, one link at a time. It receives the link’s address, not your account, and briefly holds your IP address so no single source can abuse it."
          action={
            <Switch
              id="server-read-mode"
              checked={serverReadMode}
              onCheckedChange={(next) => run(setServerReadMode(next))}
            />
          }
        />
        {serverReadMode ? (
          <SettingsRow
            title={
              <Label htmlFor="keep-read-mode-images" className="text-base font-medium">
                Include images in read-mode copies
              </Label>
            }
            description="The article’s images, kept with its text in every read-mode copy you keep. They use far more storage than the text does; with this off, a copy keeps its text only. Copies you have already kept don’t change."
            action={
              <Switch
                id="keep-read-mode-images"
                checked={keepOnSave.readModeImages}
                onCheckedChange={(readModeImages) => run(setKeepOnSave({ readModeImages }))}
              />
            }
          />
        ) : null}
      </div>

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {/* Standing text, so no role. Says where the on-save switches went, and the one
          claim this app must never make: that a save here keeps a copy. "Keep", not
          "save", for the copy: it is the word on the switches this points to, and
          "when you save a link, it can also save…" would be one verb doing two jobs. */}
      <SettingsNotice tone="info">
        When you save a link with the Bracemark browser extension, it can also keep a read-mode copy
        and a screenshot from the open tab. Choose which in the browser extension’s Settings, from
        the gear in its toolbar popup. Saving a link here in the web app can’t do that — the page
        isn’t open.
      </SettingsNotice>
    </SettingsPane>
  );
}
