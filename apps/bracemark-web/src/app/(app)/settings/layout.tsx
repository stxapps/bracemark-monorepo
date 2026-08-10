import { Sidebar } from './_panes/sidebar';
import { Topbar } from './_panes/topbar';

// Shared chrome for every settings section route (`/settings/[section]`): the
// two-pane frame — a full-height sidebar on the left; a topbar above the
// scrolling main pane on the right. The active section's content (the matching
// page) renders into `children`.
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
    <div className="flex h-dvh overflow-hidden safe-area">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
