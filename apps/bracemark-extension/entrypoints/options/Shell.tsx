import { ArrowUpRight } from 'lucide-react';

import { cn } from '@stxapps/web-ui/lib/utils';

import { WEB_APP_URL } from '@/utils/web-app-url';

// Chrome for the Settings page — and deliberately less of it than a page gets. This
// is NOT a standalone tab: index.html pins `manifest.open_in_tab: false` and the only
// way in is the popup's `runtime.openOptionsPage()`, so the document always renders
// EMBEDDED inside its host — Chrome's options dialog on chrome://extensions, or the
// Preferences tab of the browser extension's about:addons entry in Firefox. Each host
// already draws the icon, the name and a close affordance immediately above this
// document, so a header here would be the second copy of both, and a label
// distinguishing this Settings page from bracemark-web's would answer a question a
// user embedded in about:addons cannot be asking. index.html carries the reasoning
// at the point where someone would undo it.
//
// THE MEASURE IS bracemark-web's. `max-w-2xl` with `px-6` is exactly what a
// settings pane there is set to, and the headings below match its scale step for
// step (`text-xl font-semibold` for the page, `text-base font-medium` for a
// section, `text-sm text-muted-foreground` for the line under either). The two
// pages are the same product's settings, reached from two places; a user who has
// seen one should not be able to tell they've changed apps. Neither host hands this
// document the full 672px, so the measure is a ceiling rather than a target — it's
// here for the parity, and for whatever room a host gives it later.

// `min-h-dvh` SURVIVES the header's removal, and it isn't the same assumption. It
// does one job: hold the footer against the bottom of whatever frame the host gives
// this document. Chrome's options dialog has a definite height, so on a short screen
// — the signed-out state especially — dropping this would drag the footer's `border-t`
// up into the middle of the dialog with dead space under it, reading as a page that
// ended early. Firefox sizes its about:addons iframe to the content, so there the
// declaration is simply inert; it's not Chrome-specific by intent, just by which host
// hands out a viewport. It is NOT what paints the background — web-ui's `body` rule
// does that, and CSS propagates it to the canvas whatever this div measures. `dvh`
// over `vh` is house idiom only: the two differ where a mobile browser's URL bar
// collapses — the reason bracemark-web cites — and no surface in the browser
// extension has one.
export function OptionsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn('flex min-h-dvh flex-col bg-background text-foreground')}>
      <main className={cn('mx-auto w-full max-w-2xl flex-1 px-6 py-10')}>{children}</main>

      <Footer />
    </div>
  );
}

// The version is here because this is where someone looks for it when they're
// reporting that something doesn't work, and `getManifest()` means it can never
// disagree with the build. The link out is the counterpart to the popup's: this
// page holds the two settings that apply to the extension, and everything else —
// lists, tags, subscription, exports — is in the app.
function Footer() {
  const version = browser.runtime.getManifest().version;

  return (
    <footer className={cn('shrink-0 border-t border-border')}>
      <div
        className={cn(
          'mx-auto flex max-w-2xl items-center justify-between gap-4 px-6 py-4 text-xs text-muted-foreground',
        )}
      >
        <span>Version {version}</span>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-2',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
          onClick={() => {
            void browser.tabs.create({ url: `${WEB_APP_URL}/links` });
          }}
        >
          Open Bracemark
          <ArrowUpRight className={cn('size-3.5')} aria-hidden="true" />
        </button>
      </div>
    </footer>
  );
}

// One section of the page: a heading, an optional line saying what it's for, and
// the controls. Spacing lives here so Account and Theme can't drift apart by a
// few pixels each time one of them is edited.
export function OptionsSection({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(className)}>
      <h2 className={cn('text-base font-medium')}>{title}</h2>
      {description && <p className={cn('mt-1 text-sm text-muted-foreground')}>{description}</p>}
      <div className={cn('mt-4')}>{children}</div>
    </section>
  );
}
