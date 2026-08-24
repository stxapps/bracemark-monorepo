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
// `components/ui/input.tsx` — which between them cover EVERY rendered Text and
// TextInput in the app. Nothing renders a bare `react-native` Text or TextInput,
// and nothing should: the cap is only one of four things these wrappers add (the
// others are `font-sans`, TextClassContext, and the heading roles — see
// docs/accessibility.md).
//
// The share tree is covered like everything else. It differs only in HOW it
// imports them — by direct path rather than through a barrel, because its bundle
// is executed on every cold share (features/share/*, whose boundary is its own
// story — see share-root.tsx and docs/share-sheet.md). That is an import-style
// rule, not an exemption from this ceiling. The ONE exemption is the process
// below, and it is a repair, not a policy.
//
// Per-call sites can still override: both chokepoints spread `{...props}` after
// the default.
//
// NOTE: the old global `Text.defaultProps = { maxFontSizeMultiplier }` trick is
// NOT available here. React 19 removed defaultProps for function components,
// and RN's Text is one — so the policy has to ride the wrappers.
export const MAX_FONT_SIZE_MULTIPLIER = 1.3;

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PLACE SCALING HAS TO BE OFF: the iOS share-extension PROCESS.
//
// React Native computes the scale factor for every piece of text ONCE per
// surface, in `RCTFontSizeMultiplier()` (React/Base/RCTUtils.mm), as
//
//     mapping[RCTSharedApplication().preferredContentSizeCategory].floatValue
//
// and `RCTSharedApplication()` returns **nil in an app extension** — it checks
// `RCTRunningInAppExtension()` first, because `UIApplication.sharedApplication`
// is unavailable there. The dictionary lookup on a nil key yields nil and
// `.floatValue` on nil is **0.0**. That 0 becomes `layoutContext
// .fontSizeMultiplier`, and `RCTEffectiveFontSizeMultiplierFromTextAttributes`
// takes `fminf(maxFontSizeMultiplier, fontSizeMultiplier)` — our 1.3 against 0 —
// so EVERY font size in the extension resolves to **zero point**. TextInput
// takes the same value by a different route (`RCTTextInputComponentView` calls
// `RCTFontSizeMultiplier()` directly).
//
// The symptom is not a crash and not a fallback: the text nodes exist, lay out
// at zero height, carry the right strings, and paint nothing. The accessibility
// tree is fully populated — `maestro hierarchy` reads back "List: My List",
// "Save", the page title — so every automated check passes while the sheet shows
// a mark, two rows of icons and an unlabelled blue bar. Only a screenshot shows
// it. (expo-share-extension ships `Text`/`TextInput` wrappers for this and its
// README calls it "a font scaling issue"; we set the same flag at our own
// chokepoints instead, so the app's Inter/TextClassContext/role behaviour is
// kept — see docs/accessibility.md.)
//
// `allowFontScaling={false}` is the only lever. The multiplier cannot be
// corrected from JS: `ParagraphShadowNode` OVERWRITES `textAttributes
// .fontSizeMultiplier` with the layout context's value, so a hand-passed one is
// discarded, and `Dimensions.fontScale` is a useless detector here — its native
// side (`RCTAccessibilityManager`) has the `<= 0` guard `RCTFontSizeMultiplier`
// lacks and reports a clean 1.0. Hence the explicit flag: nothing about this
// process is observable from JS.
//
// THE COST, STATED PLAINLY: Dynamic Type does not reach the iOS share sheet.
// That is a real accessibility loss and it is not one we can buy back — the
// alternative is text that renders at zero size for everybody. It is scoped as
// tightly as it can be: one process, one surface, ~3 seconds, and the same page
// is fully scalable in the app the sheet saves into. Android's share sheet runs
// in the app's own process and keeps the 1.3 cap like every other screen.
let fontScalingBroken = false;

/**
 * Declare that this JS context is the iOS share-extension process, where RN's
 * font-scale multiplier is 0 and scaled text renders at zero size.
 *
 * Called from `index.share.js` — the extension bundle's entry, and the only
 * honest place to say it: the flag is per-process, and that entry IS the
 * process. Android's share activity rides `index.js` and must never call it.
 */
export function markShareExtensionProcess(): void {
  fontScalingBroken = true;
}

/** What the two chokepoints pass to `allowFontScaling`. */
export function allowsFontScaling(): boolean {
  return !fontScalingBroken;
}

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
