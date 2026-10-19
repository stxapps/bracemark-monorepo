import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { readSidebarRailCollapsed, writeSidebarRailCollapsed } from '@stxapps/expo-react';

import { HideRailButton, LinksRailProvider, ShowRailButton, useLinksRail } from './rail';

// The docked links rail's state (rail.tsx; docs/safe-area.md, _wide windows on
// native_). What can go wrong here without a symptom anywhere but a tablet:
//  - `docked` ignoring the window, so a phone gets a `permanent` drawer — the
//    rail beside a 390pt list, and the list's column math short by 280;
//  - the stored flag read in an effect rather than on the mounting render, so a
//    user who put the rail away watches it dock and vanish on every visit;
//  - a toggle that changes the screen but never reaches storage.
// The window class and the store are mocked at their seams: what is under test
// is how the provider combines them, not Uniwind's breakpoint or sqlite.

let mockWide = true;
jest.mock('../../lib/window-class', () => ({ useWideWindow: () => mockWide }));
jest.mock('@stxapps/expo-react', () => ({
  readSidebarRailCollapsed: jest.fn(),
  writeSidebarRailCollapsed: jest.fn(),
}));

// Every state the consumers branch on, printed so a render can be read back.
function Probe() {
  const { wide, docked } = useLinksRail();
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
  const { wide, docked } = useLinksRail();
  return wide && !docked ? <ShowRailButton /> : null;
}
function ProbeText({ wide, docked }: { wide: boolean; docked: boolean }) {
  return <Text testID="probe">{`wide=${wide} docked=${docked}`}</Text>;
}

const mount = () =>
  render(
    <LinksRailProvider>
      <Probe />
    </LinksRailProvider>,
  );
const state = () => screen.getByTestId('probe').props.children as string;

beforeEach(() => {
  jest.clearAllMocks();
  mockWide = true;
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
  expect(screen.queryByTestId('links-show-rail')).toBeNull();
});

// The FIRST frame already has the stored answer — nothing a later effect fixes.
it('reads a put-away rail on the mounting render', () => {
  jest.mocked(readSidebarRailCollapsed).mockReturnValue(true);
  const renders: string[] = [];
  function Recorder() {
    const { docked } = useLinksRail();
    renders.push(String(docked));
    return null;
  }
  render(
    <LinksRailProvider>
      <Recorder />
    </LinksRailProvider>,
  );
  expect(renders).not.toContain('true');
});

it('puts the rail away and brings it back, persisting each', () => {
  mount();
  fireEvent.press(screen.getByTestId('links-hide-rail'));
  expect(state()).toBe('wide=true docked=false');
  expect(writeSidebarRailCollapsed).toHaveBeenLastCalledWith(true);
  expect(screen.queryByTestId('links-hide-rail')).toBeNull();

  fireEvent.press(screen.getByTestId('links-show-rail'));
  expect(state()).toBe('wide=true docked=true');
  expect(writeSidebarRailCollapsed).toHaveBeenLastCalledWith(false);
});

it('throws outside its provider rather than guessing a layout', () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(() => render(<Probe />)).toThrow(/LinksRailProvider/);
});
