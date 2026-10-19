import { useWindowDimensions } from 'react-native';

// The ONE width at which bracemark-expo changes shape: below it a single pane
// with the rails as drawers (every phone, an iPad in Slide Over or a narrow
// Split View, a Flip's cover screen, one half of a dual-screen device); at or
// above it the rails dock beside the content (an iPad full-screen or in a wide
// Split View, an Android tablet, an unfolded foldable, a phone in landscape
// where the window is wide enough). docs/safe-area.md, _wide windows on native_.
//
// It IS Uniwind's `md:` and must stay so. Uniwind resolves a breakpoint against
// `Dimensions.get('window').width` — the app's window, which is also what
// `useWindowDimensions` reports, split-screen and freeform windows included —
// and bakes `rem` at 16 at build time (docs/theme.md, _extending_), so `md:`
// (48rem) is exactly 768 here. A JS branch on this number and a `md:` class on
// the same screen therefore flip on the same frame, which is the native form of
// web's rule "never re-derive a breakpoint from a measured width"
// (docs/safe-area.md, _the core problem_): on native there is no scrollbar to
// make the two disagree, so the window width IS what the class matched.
//
// 768 rather than Material's 600 (or 840) is web's answer carried over: it is
// where bracemark-web docks its rails, so the two clients turn into the same
// layout at the same width. What it costs is an iPad mini held upright (744)
// and a 7" Android tablet upright (600), which get the drawer — a 280 rail
// beside them would leave the list ~460 / ~320, a phone's width with a sidebar
// glued to it.
export const WIDE_MIN_WIDTH = 768;

// The docked rails' one width — links (features/links/rail.tsx) and settings
// ((app)/settings/_layout.tsx) alike, so crossing between the two moves nothing.
// Wider than web's 240 default because the rows are touch rows: the same
// `text-sm` labels, but each list row also carries a 32pt "Lock list" button
// where web reveals one on hover, and nested rows indent beside it. 280 sits in
// Material's 256–360 band for a standard drawer, and at the 768 threshold
// leaves the list 488 — one 300-minimum card column, or a row whose title still
// has room. As an OVERLAY the same rail keeps react-navigation's own width (360,
// or the window minus 56), since there it covers the list instead of sharing it.
export const RAIL_WIDTH = 280;

/**
 * Whether the window is wide enough to dock the rails — reactive, so it flips on
 * rotation, a Split View drag, a fold or unfold, and an Android window resize.
 */
export function useWideWindow(): boolean {
  const { width } = useWindowDimensions();
  return width >= WIDE_MIN_WIDTH;
}
