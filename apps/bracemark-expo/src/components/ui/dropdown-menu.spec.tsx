import * as React from 'react';
import { Dimensions, View } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import * as SafeArea from 'react-native-safe-area-context';
import * as DropdownMenuPrimitive from '@rn-primitives/dropdown-menu';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render } from '@testing-library/react-native';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { NativeOnlyAnimatedView } from './native-only-animated-view';
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

// The menu's entrance, read off the one animated wrapper this harness mounts —
// the content's (there is no sub-menu here). Undefined means no fade.
function menuEntering(root: ReturnType<typeof render>['UNSAFE_root']) {
  return root.findByType(NativeOnlyAnimatedView).props.entering;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// The positive control for the two below: without it, "the menu is not there
// yet" would pass just as well for a menu that never renders in this harness.
test('with no keyboard up, the menu opens on the press, fades in and dismisses nothing', () => {
  const { getByLabelText, getByTestId, queryByText, UNSAFE_root } = renderMenu();

  fireEvent.press(getByLabelText('List actions'));

  expect(queryByText('Rename')).not.toBeNull();
  expect(getByTestId('placed-at')).toHaveTextContent('400');
  expect(menuEntering(UNSAFE_root)).toBeDefined();
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

// The keyboard's slide already answered the press; a fade stacked after it is
// what made this path feel slow. And the skip must not outlive the open that
// earned it — a flag only ever SET would leave every later menu unfaded.
test('a menu that waited on the keyboard appears without a fade, and the next open fades again', async () => {
  const hidden = deferred();
  jest.mocked(KeyboardController.isVisible).mockReturnValueOnce(true);
  jest.mocked(KeyboardController.dismiss).mockReturnValueOnce(hidden.promise);
  const { getByLabelText, queryByText, UNSAFE_root } = renderMenu();

  fireEvent.press(getByLabelText('List actions'));
  await act(async () => hidden.resolve());

  expect(queryByText('Rename')).not.toBeNull();
  expect(menuEntering(UNSAFE_root)).toBeUndefined();

  fireEvent.press(getByLabelText('List actions')); // closes
  expect(queryByText('Rename')).toBeNull();
  fireEvent.press(getByLabelText('List actions')); // no keyboard this time

  expect(queryByText('Rename')).not.toBeNull();
  expect(menuEntering(UNSAFE_root)).toBeDefined();
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

// The clamp box (DropdownMenuContent's note). @rn-primitives clamps against the
// physical screen while placing the menu in the app's own coordinates, so
// whenever the app is smaller than the screen — Split View, Slide Over, Stage
// Manager, Android split-screen, a compatibility window — the bottom and right
// collision insets must grow by the difference or a menu is drawn past the
// app's edge. Read off the primitive's `insets` prop, which is everything the
// clamp knows; the placement itself needs an `onLayout` jest never fires.
describe('the clamp box is the app, not the screen', () => {
  function placedInsets(
    contentInsets?: React.ComponentProps<typeof DropdownMenuContent>['insets'],
  ) {
    const { getByLabelText, UNSAFE_root } = render(
      <>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="List actions">
            <Text>⋯</Text>
          </DropdownMenuTrigger>
          <DropdownMenuContent insets={contentInsets}>
            <DropdownMenuItem>
              <Text>Rename</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <PortalHost />
      </>,
    );
    fireEvent.press(getByLabelText('List actions'));
    return UNSAFE_root.findByType(DropdownMenuPrimitive.Content).props.insets;
  }

  function given(
    screen: { width: number; height: number },
    app: { width: number; height: number },
  ) {
    const get = Dimensions.get.bind(Dimensions);
    jest
      .spyOn(Dimensions, 'get')
      .mockImplementation((dim) => (dim === 'screen' ? { ...get(dim), ...screen } : get(dim)));
    jest.spyOn(SafeArea, 'useSafeAreaFrame').mockReturnValue({ x: 0, y: 0, ...app });
  }

  // The positive control: a full-screen app is clamped exactly as before.
  test('an app that fills the screen adds nothing to the gutter', () => {
    given({ width: 390, height: 844 }, { width: 390, height: 844 });
    expect(placedInsets()).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
  });

  // An iPad in Split View: the app is the left 507 of a 1032-wide screen, and
  // shorter by nothing. Without the overhang a menu near the app's right edge
  // would be allowed out to 1024.
  test('an app narrower or shorter than the screen moves the right and bottom clamps onto its edge', () => {
    given({ width: 1032, height: 1376 }, { width: 507, height: 1300 });
    expect(placedInsets()).toEqual({ top: 8, left: 8, right: 8 + 525, bottom: 8 + 76 });
  });

  // `{}` opts out of the padding, never out of staying inside the app.
  test("a caller's own insets get the overhang too", () => {
    given({ width: 1032, height: 1376 }, { width: 507, height: 1376 });
    expect(placedInsets({})).toEqual({ right: 525, bottom: 0 });
  });
});
