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
// WHICH IS WHY THE SCROLLER OWES IT A `scroll-pt`. A sticky bar INSIDE a scroll
// container covers the top 56px of the scrollport, and no scroll API knows that:
// `scrollIntoView({ block: 'nearest' })` measures against the scrollport's own
// box, so an element it lifts to the top edge lands BEHIND the bar, and one
// already sitting behind the bar counts as visible and doesn't move at all.
// That is SettingsNotice's error scroll (settings-kit.tsx) — the failure a rename
// deep in the Lists table reports was being scrolled to precisely where it could
// not be read, which looks exactly like a scroll that never fired. Driven in
// Chromium at this geometry: from a screen below, `nearest` put the notice's top
// at y=0 under a bar whose bottom is 56, fully hidden; from just above the fold
// it moved nothing.
//
// `scroll-padding-top` is the one place the browser takes that obscured band as
// an argument — it shrinks the scrollport's optimal viewing region, so both cases
// land the element clear of the bar's hairline instead, and every other scroll
// into this pane (a focused field, a jump link) gets the same correction without
// asking. It belongs HERE rather than as a `scroll-mt-*` on whatever scrolls
// itself: the bar is this frame's fact, and a notice that had to know the height
// of a bar two files away is the coupling the kit deliberately doesn't have.
// THE 18 IS THE BAR'S 14 PLUS A STEP OF AIR, and what ties the two numbers is a
// FLOOR rather than an equality. 56px is the band the bar covers, so anything
// under it leaves the notice hidden — but exactly 56 lands the notice's top edge
// welded to the bar's hairline: nothing is obscured, and a red `role="alert"`
// strip flush against the chrome's own border still reads as chrome rather than
// as something that just appeared. `scroll-padding-top` is not "the height of the
// bar", it is where the optimal viewing region starts, and the bar only sets its
// minimum. The extra 16 is the step this surface already puts between a heading
// and its content (settings-kit.tsx), so the landing is spaced in the page's own
// rhythm rather than at a number picked for this one scroll.
//
// The rule to keep, then: `scroll-pt` >= the topbar's height. Grow the bar and
// this MUST grow with it; topbar.tsx says the same on its `h-14` line, and
// nothing will report the two drifting apart.
//
// `scrollbar-gutter: stable` is the other half, and it is a TRADE. The gutter's
// width is part of the shared column's centring, so without it the whole settings
// column — bar and content together — slides sideways between a section that
// scrolls and one that doesn't (About against Lists), which is the same axis the
// bar is here to hold still. What it costs is the 15px a section too SHORT to
// scroll gives up, since the strip is reserved either way.
//
// Both halves of that trade land only where scrollbars are CLASSIC — Chrome and
// Firefox on Windows and Linux, or a Mac with "Always show scrollbars" switched
// on. `scrollbar-gutter` is spec'd to have no effect on overlay scrollbars, so on
// a default macOS the shift never happened AND this line does nothing about it:
// the property is inert in both directions, exactly as web-ui's blanket `html`
// rule is, which is why neither can be checked on a Mac at default settings
// (docs/safe-area.md). An earlier version of this note claimed a measured ~15px
// macOS cost; that reading can only have come from a machine with the
// always-show setting on.
//
// Paying on the platforms that charge, in order to be steady on them, is the same
// call the blanket `html` rule already makes for the marketing site and every
// `min-h-dvh` screen — so the surprise would be a settings pane that DIDN'T. The
// links pane's sidebar rail and both of its layouts now make it too, each for its
// own reason (see those files).
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
        <main className="min-h-0 flex-1 scroll-pt-18 scrollbar-gutter-stable overflow-y-auto">
          <Topbar />
          {children}
        </main>
      </div>
    </div>
  );
}
