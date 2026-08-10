import { type ReactNode } from 'react';
import { View } from 'react-native';

import { BRAND } from '@stxapps/shared';

import { BracemarkIcon } from './icons/bracemark-icon';
import { Text } from './ui/text';

// The mark next to the name — the one thing every surface that has no other
// brand carrier renders. It exists as a component for the reason web's DOESN'T
// need to: web types the same six utilities into four files (the auth layout,
// both settings/links rails, the browser extension's OptionsShell) and a comment
// in each says "same size, same step, same gap as the others, keep them equal".
// Native has no `className` cascade to make that cheap, and the mark's height is
// a PROP here rather than a class (react-native-svg sizes by prop), so a
// hand-typed copy drifts by a pixel the first time one is edited. One component,
// three call sites, no drift.
//
// THE MEASUREMENTS ARE WEB'S, not new ones: a 20px mark (`h-5`),
// `text-[0.9375rem] leading-none font-semibold tracking-tight` for the wordmark,
// `gap-2.5` between them. bracemark-web's links rail, its settings rail, its auth
// card and the browser extension's options page all render exactly this — it
// should be the same product wherever you entered it, and this app is the fourth
// door into it.
//
// The name comes from `BRAND.name` rather than the literal so the one file that
// owns what the product is called (shared `stores/listing-copy.ts`) owns it here
// too — that file exists because five consoles and three apps have to agree, and
// a hardcoded wordmark is precisely the drift it was written to stop.
export function BrandLockup({
  // Trailing control on the lockup's row. The rails have nothing to put there;
  // the settings topbar puts its surface label there, so the label sits ON the
  // brand row rather than floating in the bar beside it.
  action,
  testID,
}: {
  action?: ReactNode;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center gap-2.5">
      <BracemarkIcon height={20} />
      <Text testID={testID} className="text-[0.9375rem] leading-none font-semibold tracking-tight">
        {BRAND.name}
      </Text>
      {action ? <View className="ml-auto flex-row items-center">{action}</View> : null}
    </View>
  );
}
