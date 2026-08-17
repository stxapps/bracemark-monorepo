import { Sidebar } from './_panes/sidebar';
import { Topbar } from './_panes/topbar';

// Shared chrome for every settings section route (`/settings/[section]`): the
// two-pane frame — a full-height sidebar on the left; a topbar above the
// scrolling main pane on the right. The active section's content (the matching
// page) renders into `children`.
//
// THE TOPBAR IS INSIDE THE SCROLLER, not a sibling of it, and that is a layout
// decision rather than a scroll-behaviour one — it is `sticky top-0`, so it looks
// exactly as pinned as it did outside. Both the bar and every section render an
// `mx-auto max-w-2xl` column, and they can only share a left edge if they share a
// containing box: a scroll container's content box is its frame MINUS the
// scrollbar, so as siblings the two columns centred about midpoints half a
// scrollbar apart and the section sat ~7px left of "Settings" (invisible on macOS,
// whose scrollbars are overlays; ~15px wide on Windows and Linux). topbar.tsx
// carries the rest.
//
// `scrollbar-gutter: stable` is the other half, and it is a TRADE. The gutter's
// width is now part of the shared column's centring, so without it the whole
// settings column — bar and content together — slides sideways between a section
// that scrolls and one that doesn't (About against Lists), which is the same axis
// the bar is here to hold still. What it costs: Chrome reserves the strip whether
// or not that platform's scrollbar would have taken layout width, so on macOS —
// where scrollbars are overlays and the shift never happened — the pane gives up
// ~15px it used to have. Measured, at 1280 × 900: `auto` puts the gutter at 0 and
// the shift at 0 on macOS, and at 15/7.5px on a classic-scrollbar platform;
// `stable` is 15 and 0 everywhere. Paying on one platform to be steady on the
// others is the same call web-ui's blanket `html` rule already makes for the
// marketing site and every `min-h-dvh` screen, so the surprise would be a settings
// pane that DIDN'T.
//
// And it is NOT the case the frame opts out of below: that opt-out is about
// `html`'s dead gutter on a frame which can never scroll the document — a strip
// nothing can ever use, outside a pane that has its own scrollbar. This is that
// inner pane, and its gutter is the one a scrollbar actually appears in.
//
// Below `md` it is a ONE-pane frame: the sidebar hides itself and the topbar
// grows the section menu in its place (see those two files). Nothing here needs
// to know — the rail is `hidden md:flex`, so the main column takes the width it
// gives up, and there is no breakpoint measured in JS to disagree with the one
// the CSS matched (docs/safe-area.md, _the core problem_).
//
// `h-dvh` for the reason the links frame carries the full note for: a
// single-screen frame measured in `vh` hangs its bottom edge behind a mobile
// browser's URL bar, and this one has no scroll of its own to bring it back.
// `safe-area` sits on the same element for the other half of that note — on a
// border-box element the insets come out of the 100dvh instead of adding to it,
// which a wrapper one level up could not do (docs/safe-area.md).
//
// `data-no-scrollbar-gutter` follows from the same `overflow-hidden`: this frame
// can never scroll the document, so web-ui's blanket `scrollbar-gutter: stable`
// would reserve a strip at the window's right edge that nothing can ever use —
// sitting just outside the `main` pane's own scrollbar below, so a long section
// appears to have two. It belongs on THIS element and not on a `min-h-dvh`
// screen, which does scroll. web-ui/src/styles.css carries the full note.
//
// The active section lives in the URL PATH now (`/settings/lists`, …), not React
// state — so a section is a real, linkable destination: open `/settings/lists`
// straight from the links page, manage your lists, and Back returns you to
// organizing. That's why there's no provider anymore — the sidebar reads the
// active section from the pathname, each section page reads it from its route
// param, and the URL is the single source of truth.
//
// No 'use client' here — pure composition of client components. The (app) layout
// already gates this behind auth + first sync.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-no-scrollbar-gutter="" className="flex h-dvh overflow-hidden safe-area">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto">
          <Topbar />
          {children}
        </main>
      </div>
    </div>
  );
}
