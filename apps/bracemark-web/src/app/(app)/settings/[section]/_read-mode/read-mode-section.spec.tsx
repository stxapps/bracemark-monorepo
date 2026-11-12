import { act, fireEvent, render, screen } from '@testing-library/react';

import { ReadModeSection } from './read-mode-section';

// Settings → Read mode: how the web app takes a read-mode copy. What matters:
//
//   - _Server read mode_ is its own opt-in, and writes only its own field — never
//     Link previews' `serverExtraction`;
//   - _Include images_ shows only while it is on (off, the web app takes no copy for it
//     to qualify), and writes only its own field;
//   - no on-save switch, no screenshot switch — the web app takes neither;
//   - on free there is no switch at all, only the upgrade, named for the switch, and
//     nothing is rewritten, so a returning subscriber keeps their choice.

let mockKeptCopies = true;
let mockServerReadMode = false;
const mockSetServerReadMode = jest.fn(async (_enabled: boolean) => undefined);
const mockSetKeepOnSave = jest.fn(async (_patch: object) => undefined);
const mockSetServerExtraction = jest.fn(async (_enabled: boolean) => undefined);

jest.mock('@stxapps/web-react', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  useSettings: () => ({
    serverReadMode: mockServerReadMode,
    keepOnSave: { readMode: true, readModeImages: true, screenshot: false },
  }),
  useSettingMutations: () => ({
    setServerReadMode: mockSetServerReadMode,
    setKeepOnSave: mockSetKeepOnSave,
    setServerExtraction: mockSetServerExtraction,
  }),
}));

const serverReadMode = () => screen.getByRole('switch', { name: 'Server read mode' });
const images = () => screen.queryByRole('switch', { name: 'Include images in read-mode copies' });
const imagesSwitch = () =>
  screen.getByRole('switch', { name: 'Include images in read-mode copies' });

beforeEach(() => {
  mockKeptCopies = true;
  mockServerReadMode = false;
  jest.clearAllMocks();
});

test('off by default: the opt-in alone, with what it sends', () => {
  render(<ReadModeSection />);
  expect(serverReadMode().getAttribute('aria-checked')).toBe('false');
  expect(images()).toBeNull();
  expect(screen.getByText(/receives the link’s address, not your account/)).not.toBeNull();
});

test('turning it on writes its own field, never the preview opt-in', async () => {
  render(<ReadModeSection />);
  await act(async () => {
    fireEvent.click(serverReadMode());
  });
  expect(mockSetServerReadMode).toHaveBeenCalledWith(true);
  expect(mockSetServerExtraction).not.toHaveBeenCalled();
});

test('on: Include images appears, and writes only its own field', async () => {
  mockServerReadMode = true;
  render(<ReadModeSection />);

  expect(screen.getAllByRole('switch')).toHaveLength(2);
  await act(async () => {
    fireEvent.click(imagesSwitch());
  });
  expect(mockSetKeepOnSave).toHaveBeenLastCalledWith({ readModeImages: false });
});

test('free: no switch, only the upgrade named for the switch, and nothing written', () => {
  mockKeptCopies = false;
  mockServerReadMode = true;

  render(<ReadModeSection />);

  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.getByText('Server read mode')).not.toBeNull();
  expect(screen.getByText(/stay readable on every plan/)).not.toBeNull();
  expect(screen.getByRole('link', { name: /upgrade to plus/i }).getAttribute('href')).toBe(
    '/settings/subscription',
  );
  expect(mockSetServerReadMode).not.toHaveBeenCalled();
});

test('says copies on save come from the browser extension, and where to set them', () => {
  render(<ReadModeSection />);
  expect(screen.getByText(/browser extension’s Settings/)).not.toBeNull();
  expect(screen.getByText(/web app can’t do that/)).not.toBeNull();
});
