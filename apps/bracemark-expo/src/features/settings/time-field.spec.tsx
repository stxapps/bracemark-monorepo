import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { fireEvent, render } from '@testing-library/react-native';

import { TimeField } from './time-field';

// This spec exists for ONE property, the one that motivated the component: the
// control commits exactly once, with a value `coerceThemeState` accepts. A
// free-text field can't (every intermediate keystroke is invalid and gets
// coerced away on read, and each is its own synced write) — see the component
// header. So the assertions are about WHEN and WITH WHAT `onChange` fires.
//
// jest-expo resolves the `.ios` platform (the babel caller in
// jest.expo-base.cjs pins it), so what's exercised here is the Dialog + spinner
// half — the draft, Done and Cancel. Android's is `DateTimePickerAndroid.open`,
// an imperative native dialog reached through the package's `.android.js`
// siblings, which this platform never loads; the package ships jest helpers for
// it (`@react-native-community/datetimepicker/jest`) if an android-platform
// project is ever added.

// The picker is mocked whole: it's a native spinner, and this spec is about the
// WIRING around it (which is ours), not the vendor's wrapper. The stub stands in
// for one spin — press it and it reports `mockNextPick`.
let mockNextPick = new Date();

jest.mock('@react-native-community/datetimepicker', () => {
  // Required inside the factory, not closed over: jest hoists this above the
  // imports, so an out-of-scope `React`/`Pressable` is a ReferenceError.
  const react = require('react');
  const { Pressable } = require('react-native');
  return {
    __esModule: true,
    default: ({ onChange }: { onChange: (event: unknown, date?: Date) => void }) =>
      react.createElement(Pressable, {
        testID: 'spin',
        onPress: () => onChange({ type: 'set' }, mockNextPick),
      }),
    DateTimePickerAndroid: { open: jest.fn() },
  };
});

jest.mock('../../components/theme-provider', () => ({
  useTheme: () => ({ effectiveTheme: 'light' }),
}));

const at = (hours: number, minutes: number) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
};

const setup = (value = '06:00') => {
  const onChange = jest.fn();
  // The Dialog portals to the default host, which the root `_layout.tsx` mounts
  // in the app — stand it up here or the picker renders nowhere.
  const utils = render(
    <>
      <TimeField label="Light starts" value={value} onChange={onChange} />
      <PortalHost />
    </>,
  );
  return { ...utils, onChange };
};

// Opening the picker is not itself an edit — web's `type="time"` doesn't fire
// change on focus either.
test('does not write while the picker is merely open', () => {
  const { getByLabelText, onChange } = setup();

  fireEvent.press(getByLabelText(/Light starts/));

  expect(onChange).not.toHaveBeenCalled();
});

test('commits once, as "HH:mm", on Done', () => {
  const { getByLabelText, getByText, getByTestId, onChange } = setup('06:00');

  fireEvent.press(getByLabelText(/Light starts/));

  // Two spins before confirming — the draft absorbs them, the store sees none.
  mockNextPick = at(18, 45);
  fireEvent.press(getByTestId('spin'));
  mockNextPick = at(7, 5);
  fireEvent.press(getByTestId('spin'));
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.press(getByText('Done'));

  expect(onChange).toHaveBeenCalledTimes(1);
  // Zero-padded on both halves — `coerceThemeState`'s regex demands it, and
  // "7:5" would silently revert the setting to its default on the next read.
  expect(onChange).toHaveBeenCalledWith('07:05');
});

test('discards the draft on Cancel', () => {
  const { getByLabelText, getByText, getByTestId, onChange } = setup('06:00');

  fireEvent.press(getByLabelText(/Light starts/));
  mockNextPick = at(23, 30);
  fireEvent.press(getByTestId('spin'));
  fireEvent.press(getByText('Cancel'));

  expect(onChange).not.toHaveBeenCalled();
});

// Reopening must start from the STORED value, not the abandoned draft.
test('reopens on the stored value after a cancel', () => {
  const { getByLabelText, getByText, getByTestId, onChange } = setup('06:00');

  fireEvent.press(getByLabelText(/Light starts/));
  mockNextPick = at(23, 30);
  fireEvent.press(getByTestId('spin'));
  fireEvent.press(getByText('Cancel'));

  fireEvent.press(getByLabelText(/Light starts/));
  fireEvent.press(getByText('Done'));

  expect(onChange).toHaveBeenCalledWith('06:00');
});

// Midnight is the one value where a sloppy format ("0:0") still looks plausible.
test('pads a midnight pick', () => {
  const { getByLabelText, getByText, getByTestId, onChange } = setup('06:00');

  fireEvent.press(getByLabelText(/Light starts/));
  mockNextPick = at(0, 0);
  fireEvent.press(getByTestId('spin'));
  fireEvent.press(getByText('Done'));

  expect(onChange).toHaveBeenCalledWith('00:00');
});
