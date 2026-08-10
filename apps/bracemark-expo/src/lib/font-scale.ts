import { useWindowDimensions } from 'react-native';

// The app-wide accessibility font-scale policy.
//
// React Native's default is `allowFontScaling: true` with NO ceiling, so iOS
// Dynamic Type (up to ~310%) and Android's font-size setting scale every Text /
// TextInput without bound — while every Tailwind box dimension (h-14 topbars,
// h-10 rows, h-9 inputs, the button heights) is dp and does NOT scale. Past a
// point text simply overflows its chrome.
//
// So we CAP rather than disable. `allowFontScaling={false}` would keep the
// layout pristine at the cost of making the app unreadable for exactly the
// users who changed the setting — an accessibility regression aimed at the
// people the setting exists for. 1.3 keeps the common small bumps working,
// which covers most of the affected users, and bounds the overflow to what the
// fixed heights absorb.
//
// Applied at the two component chokepoints — `components/ui/text.tsx` and
// `components/ui/input.tsx` — which between them cover every rendered Text and
// TextInput in the app EXCEPT the share tree, which reaches for them directly
// (features/share/*, whose bundle boundary is its own story — see
// share-root.tsx). Per-call sites can still override: both chokepoints spread
// `{...props}` after the default.
//
// NOTE: the old global `Text.defaultProps = { maxFontSizeMultiplier }` trick is
// NOT available here. React 19 removed defaultProps for function components,
// and RN's Text is one — so the policy has to ride the wrappers.
export const MAX_FONT_SIZE_MULTIPLIER = 1.3;

/**
 * The device font scale clamped to [1, MAX_FONT_SIZE_MULTIPLIER] — for the rare
 * layout that must size a FIXED box around scaling text (link-card.tsx's height
 * budget is the one case). Text itself doesn't need this: `maxFontSizeMultiplier`
 * on the chokepoints already applies the ceiling natively.
 *
 * Floored at 1 because the layouts were drawn at 1.0: a user who picks SMALLER
 * system text gets the designed box rather than a shrunken one (the text still
 * shrinks — nothing clips, and the grid keeps its intended proportions).
 *
 * Reactive by design — `useWindowDimensions` re-renders on a system font-size
 * change, which the static `PixelRatio.getFontScale()` would not.
 */
export function useCappedFontScale(): number {
  const { fontScale } = useWindowDimensions();
  return Math.min(Math.max(fontScale, 1), MAX_FONT_SIZE_MULTIPLIER);
}
