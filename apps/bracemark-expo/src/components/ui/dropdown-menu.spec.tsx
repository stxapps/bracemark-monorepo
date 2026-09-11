import * as React from 'react';
import { View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import * as DropdownMenuPrimitive from '@rn-primitives/dropdown-menu';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render } from '@testing-library/react-native';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Text } from './text';

// DropdownMenuTrigger's keyboard hand-off (its note in dropdown-menu.tsx;
// docs/soft-keyboard.md, _dismissal_). The failure it prevents is only visible
// on a device: a menu opened over a keyboard is placed from where its ⋯ was
// BEFORE the keyboard went down, and the settings page then scrolls the ⋯ away
// from it. So what is pinned here is the ordering — no menu while the keyboard
// is still going, and a placement taken from the trigger's position AFTER.
//
// `measure` stands in for Fabric's, which calls back synchronously; the jest
// mock of View never calls back at all, and the primitive would then never
// place a menu. `triggerY` is where the trigger "is" at the moment of the call,
// so moving it between the press and the keyboard's hide is the scroll-back.
let triggerY = 0;

beforeEach(() => {
  triggerY = 400;
  jest
    .spyOn(View.prototype, 'measure')
    .mockImplementation((callback) => callback(0, 0, 32, 32, 300, triggerY));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// The position the menu would be placed from — read off the primitive's own
// context, since the placement itself needs an `onLayout` jest never fires.
function PlacedAt() {
  const { triggerPosition } = DropdownMenuPrimitive.useRootContext();
  return <Text testID="placed-at">{triggerPosition ? String(triggerPosition.pageY) : 'none'}</Text>;
}

function renderMenu() {
  return render(
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="List actions">
          <Text>⋯</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            <Text>Rename</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
        <PlacedAt />
      </DropdownMenu>
      <PortalHost />
    </>,
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// The positive control for the two below: without it, "the menu is not there
// yet" would pass just as well for a menu that never renders in this harness.
test('with no keyboard up, the menu opens on the press and dismisses nothing', () => {
  const { getByLabelText, getByTestId, queryByText } = renderMenu();

  fireEvent.press(getByLabelText('List actions'));

  expect(queryByText('Rename')).not.toBeNull();
  expect(getByTestId('placed-at')).toHaveTextContent('400');
  expect(KeyboardController.dismiss).not.toHaveBeenCalled();
});

test('with a keyboard up, the menu waits for it to go and is placed from where the trigger ends up', async () => {
  const hidden = deferred();
  jest.mocked(KeyboardController.isVisible).mockReturnValueOnce(true);
  jest.mocked(KeyboardController.dismiss).mockReturnValueOnce(hidden.promise);
  const { getByLabelText, getByTestId, queryByText } = renderMenu();

  fireEvent.press(getByLabelText('List actions'));

  // Not even for a frame: the press's own (stale) measurement is withheld in
  // the same update that opened the menu.
  expect(KeyboardController.dismiss).toHaveBeenCalledTimes(1);
  expect(queryByText('Rename')).toBeNull();
  expect(getByTestId('placed-at')).toHaveTextContent('none');

  triggerY = 120; // the page scrolls back as the keyboard goes down
  await act(async () => hidden.resolve());

  expect(queryByText('Rename')).not.toBeNull();
  expect(getByTestId('placed-at')).toHaveTextContent('120');
});

test('a hide event that never arrives still places the menu, rather than leaving the ⋯ dead', async () => {
  jest.useFakeTimers();
  jest.mocked(KeyboardController.isVisible).mockReturnValueOnce(true);
  jest.mocked(KeyboardController.dismiss).mockReturnValueOnce(new Promise<void>(() => undefined));
  const { getByLabelText, queryByText } = renderMenu();

  fireEvent.press(getByLabelText('List actions'));
  expect(queryByText('Rename')).toBeNull();

  await act(async () => {
    jest.advanceTimersByTime(1000);
  });

  expect(queryByText('Rename')).not.toBeNull();
});
