import { type ReactNode } from 'react';
import { View } from 'react-native';

import { BRAND } from '@stxapps/shared';

import { BracemarkIcon } from './icons/bracemark-icon';
import { Text } from './ui/text';

// The mark next to the name — the one thing every surface that has no other
// brand carrier renders. It exists as a component for the reason web's DOESN'T
// need to: web types the same utilities into four files (the auth layout, both
// settings/links rails, the browser extension's popup header) and a comment in
// each says "same size, same step, same gap as the others, keep them equal".
// Native has no `className` cascade to make that cheap, and the mark's height is
// a PROP here rather than a class (react-native-svg sizes by prop), so a
// hand-typed copy drifts by a pixel the first time one is edited. One component,
// five call sites, no drift.
//
// THE MEASUREMENTS ARE WEB'S, not new ones: a 16px mark (`h-4` there),
// `text-[0.9375rem] leading-none font-semibold tracking-tight` for the wordmark,
// `gap-2.5` between them. bracemark-web's links rail, its settings rail, its auth
// card and the browser extension's popup all render exactly this — it should be
// the same product wherever you entered it, and this app is the fourth door into
// it.
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
      <Text testID={testID} className="text-[0.9375rem] leading-none font-semibold tracking-tight">
        {BRAND.name}
      </Text>
      {action ? <View className="ml-auto flex-row items-center">{action}</View> : null}
    </View>
  );
}
