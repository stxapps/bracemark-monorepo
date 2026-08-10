import { ArrowUpRight } from 'lucide-react';

import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { cn } from '@stxapps/web-ui/lib/utils';

import { WEB_APP_URL } from '@/utils/web-app-url';

// Chrome for the Settings page. Unlike the popup, this is a real full-width tab,
// so the frame's job is the opposite one: not to fit a tiny window, but to stop a
// short page from floating in a wide one.
//
// THE MEASURE IS bracemark-web's. `max-w-2xl` with `px-6` is exactly what a
// settings pane there is set to, and the headings below match its scale step for
// step (`text-xl font-semibold` for the page, `text-base font-medium` for a
// section, `text-sm text-muted-foreground` for the line under either). The two
// pages are the same product's settings, reached from two places; a user who has
// seen one should not be able to tell they've changed apps. The 460px column this
// replaced was neither the app's measure nor a comfortable one.
//
// The topbar names the surface on the right — "Browser extension". Both this page
// and bracemark-web's are titled "Settings", they can be open in adjacent tabs, and
// only one of them is where the theme for THIS browser gets set. One label in the
// corner is cheaper than the wrong tab getting edited.

export function OptionsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn('flex min-h-dvh flex-col bg-background text-foreground')}>
      <header
        className={cn(
          'sticky top-0 z-20 shrink-0 border-b border-border bg-background/90 backdrop-blur-md',
        )}
      >
        <div className={cn('mx-auto flex h-14 max-w-2xl items-center gap-2.5 px-6')}>
          <BracemarkIcon className={cn('h-5 w-auto shrink-0')} aria-hidden="true" />
          <span className={cn('text-[0.9375rem] leading-none font-semibold tracking-tight')}>
            Bracemark
          </span>
          <span className={cn('ml-auto text-xs text-muted-foreground')}>Browser extension</span>
        </div>
      </header>

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
