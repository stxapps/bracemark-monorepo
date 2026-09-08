import { type ReactNode } from 'react';
import { View } from 'react-native';

import { BRAND } from '@stxapps/shared';

import { BracemarkIcon } from './icons/bracemark-icon';
import { Text } from './ui/text';

// The mark next to the name — the one thing every surface that has no other
// brand carrier renders. Web has the same component now
// (`packages/web-ui/src/components/brand-lockup.tsx`, four call sites: the auth
// card, both settings/links rails, the browser extension's popup header); this
// file is its port, and the two are one lockup in two languages. Web reached it
// second, having typed the utilities into all four files with a comment in each
// saying "same size, same step, same gap as the others, keep them equal" — a
// rule stated four times and enforced nowhere, which the popup had already
// drifted off once. Native never had that option to begin with: there is no
// `className` cascade to make a hand-typed copy cheap, and the mark's height is
// a PROP here rather than a class (react-native-svg sizes by prop), so a copy
// drifts by a pixel the first time one is edited. Nine call sites, two
// components, no drift.
//
// THE MEASUREMENTS ARE WEB'S, not new ones: a 16px mark (`h-4` there),
// `text-[0.9375rem] leading-none font-semibold tracking-tight` for the wordmark,
// `gap-2.5` between them. bracemark-web's links rail, its settings rail, its auth
// card and the browser extension's popup all render exactly this, through
// web-ui's `BrandLockup` — it should be the same product wherever you entered it,
// and this app is the fourth door into it. Those spellings are duplicated here
// rather than imported because there is nothing to import: Uniwind and Tailwind
// are separate compilers over separate stylesheets. Change one, change the other
// — with the single exception the next paragraph is about.
//
// THE LEADING IS THE ONE SPELLING NOT PORTED. The wordmark below carries no
// `leading-*`, and putting web's `leading-none` back is what pulls the name off
// the mark's middle — `items-center` still centres the two BOXES to the pixel;
// what moves is where the caps sit INSIDE the text's own box. Web's 15px line
// box splits its (negative) half-leading evenly above and below the glyphs, so
// the caps land dead centre in it. iOS does not split it. The class maps here
// perfectly well — Uniwind resolves the unitless `1` against the element's own
// font-size (`core/native/store.js`: `lineHeight < 6` → `× fontSize`), so RN
// receives a 15pt lineHeight against Inter's natural 18.15pt at this size — and
// `RCTApplyBaselineOffsetForRange` (react-native 0.81) returns EARLY rather than
// compensating whenever `maximumLineHeight < font.lineHeight`, which leaves
// TextKit to take the whole 3.15pt deficit off the ascent. Measured through
// TextKit with this app's own `assets/fonts/InterVariable.ttf` at 15pt: baseline
// 11.0 from the top of a 15pt box, cap block centred at 5.54 against the box's
// 7.5 — the wordmark rides ~2px high beside a mark that fills its 16px box.
// Android splits the deficit evenly (`CustomLineHeightSpan`) and drifts ~0.5px,
// so what you see depends on the platform you looked at.
//
// With no leading at all the font's own box centres the caps for free, on both:
// Inter's ascender minus its cap height is 3.62pt and its descender is 3.62pt
// (1984 − 1490 = 494 units), and its `win` metrics equal its `hhea` ones, so
// Android's `includeFontPadding` adds nothing asymmetric either. The cost is 3pt
// of row height (18.15 vs 15), which no call site can see: the two rails and the
// share sheet's header fix their own (`h-14`, `h-9`), the auth screen and the
// landing space this row with `gap-*`. Nothing lints or tests any of it —
// docs/theme.md, _extending_, and docs/brand-assets.md, _the lockup_.
//
// THE PAIR IS A RATIO, and the height below is the half of it that can't say so.
// 16 against 15 is the mark at 1.6× the wordmark's cap height — the proportion
// docs/brand-assets.md pins — and it is simultaneously the floor, since the 45°
// cut stops reading under 16px (see this app's `icons/bracemark-icon.tsx`).
// Changing one number without the other is the exact drift that got into the
// browser extension's popup once already; going below 16 is never right.
// Note the ratio can't be EXPRESSED here: `rem` is baked at build time in expo
// and react-native-svg takes a number, so this is arithmetic done at authoring
// time (docs/theme.md, _extending_).
//
// The name comes from `BRAND.name` rather than the literal so the one file that
// owns what the product is called (shared `brand/brand.ts`) owns it here
// too — that file exists because five consoles and three apps have to agree, and
// a hardcoded wordmark is precisely the drift it was written to stop.
export function BrandLockup({
  // Trailing control on the lockup's row. The rails have nothing to put there;
  // the settings topbar puts its surface label there, so the label sits ON the
  // brand row rather than floating in the bar beside it.
  //
  // IT IS PLACED WITH `ml-auto`, so it is only rightmost if this component's own
  // row is as wide as the header — which makes the PARENT's flex direction part
  // of the contract. Give it a column (`h-14 justify-center`, as both rails do;
  // `h-9 justify-center` in the share sheet's header) and the row stretches; put
  // it in a `flex-row` and it shrinks to its content, which parks the control
  // mid-header hard against the wordmark. The share sheet shipped that way, and
  // nothing but the eye can catch it: it is a valid layout of a valid tree.
  action,
  testID,
}: {
  action?: ReactNode;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center gap-2.5">
      <BracemarkIcon height={16} />
      {/* No `leading-*` — see the leading paragraph above; web's `leading-none`
          does not port. */}
      <Text testID={testID} className="text-[0.9375rem] font-semibold tracking-tight">
        {BRAND.name}
      </Text>
      {action ? <View className="ml-auto flex-row items-center">{action}</View> : null}
    </View>
  );
}
