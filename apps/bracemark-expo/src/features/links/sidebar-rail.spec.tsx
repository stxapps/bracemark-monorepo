import { Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import {
  readSidebarRailCollapsed,
  writeSidebarRailCollapsed,
  writeSidebarRailWidth,
} from '@stxapps/expo-react';

import {
  HideRailButton,
  RailWidthHandle,
  ShowRailButton,
  SidebarRailProvider,
  useSidebarRail,
} from './sidebar-rail';

// The docked links rail's state (sidebar-rail.tsx; docs/safe-area.md, _wide windows on
// native_). What can go wrong here without a symptom anywhere but a tablet:
//  - `docked` ignoring the window, so a phone gets a `permanent` drawer — the
//    rail beside a 390pt list, and the list's column math short by 280;
//  - the stored flag read in an effect rather than on the mounting render, so a
//    user who put the rail away watches it dock and vanish on every visit;
//  - a toggle that changes the screen but never reaches storage;
//  - a width written to the wrong shape, or a drag's step that the Drawer and
//    the card grid (both reading `width`) never see.
// The drag itself is device-only (the gesture-handler stub in testing/setup.ts
// renders the grip but runs no gesture); its screen-reader form, the adjustable
// actions, takes the same path to the store and is driven here.
// The window class and the store are mocked at their seams: what is under test
// is how the provider combines them, not Uniwind's breakpoint or sqlite.

let mockWide = true;
// What useRailWidth resolved — the upright 11" iPad (820), which offers up to 320.
const UPRIGHT_11 = { shape: 'portrait', width: 280, steps: [240, 280, 320] };
let mockRail: { shape: string; width: number; steps: readonly number[] } = UPRIGHT_11;
jest.mock('../../lib/window-class', () => ({ useWideWindow: () => mockWide }));
jest.mock('./sidebar-rail-width', () => ({
  ...jest.requireActual('./sidebar-rail-width'),
  useRailWidth: () => mockRail,
}));
jest.mock('@stxapps/expo-react', () => ({
  readSidebarRailCollapsed: jest.fn(),
  writeSidebarRailCollapsed: jest.fn(),
  writeSidebarRailWidth: jest.fn(),
}));

// Every state the consumers branch on, printed so a render can be read back.
function Probe() {
  const { wide, docked } = useSidebarRail();
  return (
    <>
      <ShowRailOrNothing />
      {docked && <HideRailButton />}
      <ProbeText wide={wide} docked={docked} />
    </>
  );
}
// The topbar's rule: Show only while wide and put away.
function ShowRailOrNothing() {
  const { wide, docked } = useSidebarRail();
  return wide && !docked ? <ShowRailButton /> : null;
}
function ProbeText({ wide, docked }: { wide: boolean; docked: boolean }) {
  return <Text testID="probe">{`wide=${wide} docked=${docked}`}</Text>;
}

const mount = () =>
  render(
    <SidebarRailProvider>
      <Probe />
    </SidebarRailProvider>,
  );
const state = () => screen.getByTestId('probe').props.children as string;

beforeEach(() => {
  jest.clearAllMocks();
  mockWide = true;
  mockRail = UPRIGHT_11;
  jest.mocked(readSidebarRailCollapsed).mockReturnValue(false);
});

it('docks on a wide window, and never on a narrow one whatever is stored', () => {
  mount();
  expect(state()).toBe('wide=true docked=true');

  mockWide = false;
  jest.mocked(readSidebarRailCollapsed).mockReturnValue(false);
  screen.unmount();
  mount();
  expect(state()).toBe('wide=false docked=false');
  expect(screen.queryByTestId('sidebar-rail-show')).toBeNull();
});

// The FIRST frame already has the stored answer — nothing a later effect fixes.
it('reads a put-away rail on the mounting render', () => {
  jest.mocked(readSidebarRailCollapsed).mockReturnValue(true);
  const renders: string[] = [];
  function Recorder() {
    const { docked } = useSidebarRail();
    renders.push(String(docked));
    return null;
  }
  render(
    <SidebarRailProvider>
      <Recorder />
    </SidebarRailProvider>,
  );
  expect(renders).not.toContain('true');
});

it('puts the rail away and brings it back, persisting each', () => {
  mount();
  fireEvent.press(screen.getByTestId('sidebar-rail-hide'));
  expect(state()).toBe('wide=true docked=false');
  expect(writeSidebarRailCollapsed).toHaveBeenLastCalledWith(true);
  expect(screen.queryByTestId('sidebar-rail-hide')).toBeNull();

  fireEvent.press(screen.getByTestId('sidebar-rail-show'));
  expect(state()).toBe('wide=true docked=true');
  expect(writeSidebarRailCollapsed).toHaveBeenLastCalledWith(false);
});

it('throws outside its provider rather than guessing a layout', () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(() => render(<Probe />)).toThrow(/SidebarRailProvider/);
});

describe('the width grip', () => {
  const grip = () => screen.getByTestId('sidebar-rail-width');
  const adjust = (actionName: 'increment' | 'decrement') =>
    fireEvent(grip(), 'accessibilityAction', { nativeEvent: { actionName } });
  const mountGrip = () =>
    render(
      <SidebarRailProvider>
        <RailWidthHandle />
      </SidebarRailProvider>,
    );

  // An accessibility element at all — a View is not one by default, and without
  // it VoiceOver never lands on the grip to hear its value or step it.
  it('is a named adjustable element that announces its step', () => {
    mountGrip();
    expect(screen.getByRole('adjustable', { name: 'Sidebar width' })).toBe(grip());
    expect(grip().props.accessibilityValue).toEqual({ text: 'Narrow' });
  });

  // Centred on the rail's edge, wherever that is: the grip is drawn over the Drawer
  // (Android gives a child of the rail no touch past the rail's own edge), so
  // nothing but this offset keeps it on the edge, mid-drag included. A grip left
  // behind a snap is a pill floating in the list and an edge with no grip.
  it('sits across the edge, and stays on it through a drag', () => {
    let rail: ReturnType<typeof useSidebarRail> | undefined;
    function Reader() {
      rail = useSidebarRail();
      return null;
    }
    render(
      <SidebarRailProvider>
        <Reader />
        <RailWidthHandle />
      </SidebarRailProvider>,
    );
    expect(grip().props.style).toEqual({ left: 256, width: 48 });

    act(() => rail?.setDragTarget(320));
    expect(grip().props.style).toEqual({ left: 296, width: 48 });
  });

  // Lit from the touch itself, and out again on every way a touch ends: on iOS a
  // press that never moved ends with no call from the pan, so a pill lit through
  // the gesture stays lit. A drag cancels the touch, and has to keep it lit.
  it('lights on touch and goes out however the touch ends', () => {
    let rail: ReturnType<typeof useSidebarRail> | undefined;
    function Reader() {
      rail = useSidebarRail();
      return null;
    }
    render(
      <SidebarRailProvider>
        <Reader />
        <RailWidthHandle />
      </SidebarRailProvider>,
    );
    const lit = () => {
      const [pill] = grip().children as unknown as { props: { className: string } }[];
      return pill.props.className.includes('bg-ring');
    };
    expect(lit()).toBe(false);

    fireEvent(grip(), 'touchStart');
    expect(lit()).toBe(true);
    fireEvent(grip(), 'touchEnd');
    expect(lit()).toBe(false);

    fireEvent(grip(), 'touchStart');
    act(() => rail?.setDragTarget(320));
    fireEvent(grip(), 'touchCancel');
    expect(lit()).toBe(true);
    act(() => rail?.setDragTarget(null));
    expect(lit()).toBe(false);
  });

  // Written under the window's OWN shape, so the other shape keeps its width.
  it('steps narrower for this window shape', () => {
    mountGrip();
    adjust('decrement');
    expect(writeSidebarRailWidth).toHaveBeenLastCalledWith('portrait', 240);
  });

  // The upright 11" offers up to 320: there is no wider step to write there, and
  // writing 360 anyway would dock at 320 and announce Wide.
  it('steps no wider than this window offers', () => {
    mockRail = { ...UPRIGHT_11, width: 320 };
    mountGrip();
    adjust('increment');
    expect(writeSidebarRailWidth).not.toHaveBeenCalled();

    mockRail = { shape: 'landscape', width: 360, steps: [240, 280, 320, 360, 400] };
    screen.unmount();
    mountGrip();
    adjust('increment');
    expect(writeSidebarRailWidth).toHaveBeenLastCalledWith('landscape', 400);
  });
});

// Mid-drag the rail is laid out at the step the edge is over, and the Drawer and
// the card grid both read it from `width` — so that is what has to move.
it("reports a drag's step as the width, and the narrowest over the collapse zone", () => {
  let rail: ReturnType<typeof useSidebarRail> | undefined;
  function Reader() {
    rail = useSidebarRail();
    return null;
  }
  render(
    <SidebarRailProvider>
      <Reader />
    </SidebarRailProvider>,
  );
  expect(rail?.width).toBe(280);

  act(() => rail?.setDragTarget(320));
  expect(rail?.width).toBe(320);
  expect(rail?.settledWidth).toBe(280);
  act(() => rail?.setDragTarget('collapse'));
  expect(rail?.width).toBe(240);
  act(() => rail?.setDragTarget(null));
  expect(rail?.width).toBe(280);
});
