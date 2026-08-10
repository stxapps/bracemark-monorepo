import { ArrowLeft } from 'lucide-react';

import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

// The popup's frame: a header bar, the body, and an optional docked footer. Every
// screen in the popup renders through it, which is the point — the width, the
// padding rhythm and the two hairlines are declared once here instead of being
// re-typed as `w-85 p-4` on six components that then drift.
//
// WIDTH. A toolbar popup has no viewport to be responsive to: the browser sizes
// the window to the document, so whatever this div measures IS the popup. 360px
// (w-90) rather than the 340 it replaced — the list picker and the tag field are
// both comboboxes with a trigger, a chevron and a truncating label, and at 340
// the trigger text was clipping at list names that fit fine in bracemark-web's
// 320px quick-add popover, because that popover doesn't also carry 32px of popup
// padding. There is no scroll container: Chrome grows the popup to its content
// and starts scrolling the document itself at 600px, so an inner `overflow-y`
// would only produce two nested scrollbars. The header is sticky instead.
//
// THE HEADER HAS TWO MODES, and which one shows says where you are:
//   - root (the save flow, sign-in) — the mark and the wordmark, because a
//     toolbar popup opens with no context around it: no tab title, no URL bar
//     entry, nothing else that says which extension this is. bracemark-web can
//     leave the wordmark to its sidebar; here this is the only place the name
//     appears. `actions` fills the right side — Settings, replacing an
//     absolutely-positioned gear that had nothing to anchor to and overlapped
//     the heading beneath it.
//   - sub-view (sync detail) — a back button and the view's name in the
//     wordmark's slot. The brand steps aside rather than sitting above a second
//     title in 360px of width.

export function PopupShell({
  title,
  onBack,
  actions,
  footer,
  children,
}: {
  // The sub-view's name. Shown in place of the wordmark, and only alongside
  // `onBack` — a titled screen with no way back would be a dead end.
  title?: string;
  onBack?: () => void;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex w-90 flex-col bg-background text-foreground')}>
      <header
        className={cn(
          'sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-4',
        )}
      >
        {onBack ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back"
              className={cn('-ml-1.5')}
              onClick={onBack}
            >
              <ArrowLeft className={cn('size-4')} />
            </Button>
            <span
              className={cn('truncate text-[0.8125rem] leading-none font-semibold tracking-tight')}
            >
              {title}
            </span>
          </>
        ) : (
          <>
            <BracemarkIcon className={cn('h-4 w-auto shrink-0')} aria-hidden="true" />
            <span className={cn('text-[0.8125rem] leading-none font-semibold tracking-tight')}>
              Bracemark
            </span>
          </>
        )}
        <div className={cn('-mr-1.5 ml-auto flex items-center gap-0.5')}>{actions}</div>
      </header>

      {children}

      {footer}
    </div>
  );
}

// The standard body padding — one value, so the specimen, the form and the
// footer all sit on the same 16px margin.
export function PopupBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn('flex flex-col gap-4 p-4', className)}>{children}</div>;
}

// A whole-body state with nothing to act on yet: loading, or a tab that can't be
// saved. Given a floor height so the popup doesn't collapse to a sliver and then
// jump to full size a frame later when the real content resolves.
export function PopupMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-h-32 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center',
      )}
    >
      {children}
    </div>
  );
}

// The small heading that names what this screen is for ("Save this page",
// "Saved"). Sized to bracemark-web's settings sub-heading idiom (`text-base
// font-medium`) minus a step, since the popup's whole column is one step down
// from a settings pane.
export function PopupTitle({ children }: { children: React.ReactNode }) {
  return <h1 className={cn('text-sm leading-none font-medium')}>{children}</h1>;
}
