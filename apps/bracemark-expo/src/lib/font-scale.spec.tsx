// The one automated check the iOS share sheet's blank-text bug can have.
//
// Font scaling is broken in an app-extension process — RN's multiplier resolves
// to 0 there, so every `Text`/`TextInput` lays out at zero point and paints
// nothing while its strings stay in the accessibility tree (font-scale.ts has
// the derivation). jest cannot see THAT: it renders no glyphs, `RCTUtils.mm`
// isn't running, and the Maestro flows assert on the accessibility tree, which
// is correct in the broken build. Only a screenshot showed it.
//
// So this pins the REPAIR instead — the wiring that carries the answer from the
// extension's entry to the two chokepoints. Delete either end and the rest of
// the suite stays green.
//
// ONE test, not three, and deliberately: the flag is module state and it is
// one-way (`index.share.js` sets it and nothing clears it), so the before/after
// halves have to be two halves of the same test rather than two tests relying on
// declaration order. `jest.resetModules()` is the obvious alternative and it is
// wrong here — a re-required `text.tsx` gets a fresh `react` while the renderer
// keeps the old one, which fails as "Invalid hook call".

import * as React from 'react';
import { render } from '@testing-library/react-native';

import { Input } from '../components/ui/input';
import { Text } from '../components/ui/text';

// All this spec wants from the extension entry is the one call it makes on its
// way to `registerComponent`; the share tree and the polyfills are noise here
// (and the polyfills reach for native modules).
jest.mock('../features/share/share-root', () => ({ ShareRoot: () => null }));
jest.mock('../polyfills', () => ({}));

const textProps = () => render(<Text testID="probe">probe</Text>).getByTestId('probe').props;
const inputProps = () => render(<Input testID="probe" />).getByTestId('probe').props;

test('the iOS share-extension entry is what turns font scaling off', () => {
  // The app process — every other surface. Scaling on, capped at 1.3.
  expect(textProps()).toMatchObject({ allowFontScaling: true, maxFontSizeMultiplier: 1.3 });
  expect(inputProps()).toMatchObject({ allowFontScaling: true, maxFontSizeMultiplier: 1.3 });

  // Loading the iOS extension bundle's entry is the whole mechanism. Android's
  // share activity rides `index.js` in the app's own process and never gets
  // here, which is why the flag lives on the entry and not in the share tree.

  require('../../index.share');

  expect(textProps().allowFontScaling).toBe(false);
  expect(inputProps().allowFontScaling).toBe(false);
});
