import { act, fireEvent, render, screen } from '@testing-library/react';

import { KeptCopiesGroup } from './kept-copies-group';

// The kept-copies save setting. What matters is what each switch WRITES and what an
// unentitled account sees — the stored value and the plan are separate facts, and
// the screen must not blur them:
//
//   - a toggle writes only its own half (the other half stays whatever it was);
//   - on free both switches read OFF and can't be moved, whatever is stored, so the
//     screen never claims a capture the plan won't run — and nothing is rewritten,
//     so a returning subscriber keeps their choice.

let mockKeptCopies = true;
let mockKeepOnSave = { readMode: true, screenshot: false };
const mockSetKeepOnSave = jest.fn(async (_patch: object) => undefined);

jest.mock('@stxapps/web-react', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  useSettings: () => ({ keepOnSave: mockKeepOnSave }),
  useSettingMutations: () => ({ setKeepOnSave: mockSetKeepOnSave }),
}));

const readMode = () => screen.getByRole('switch', { name: 'Keep read mode on save' });
const screenshot = () => screen.getByRole('switch', { name: 'Keep a screenshot on save' });

beforeEach(() => {
  mockKeptCopies = true;
  mockKeepOnSave = { readMode: true, screenshot: false };
  mockSetKeepOnSave.mockClear();
});

test('shows the resolved setting: read mode on, screenshot off', () => {
  render(<KeptCopiesGroup />);
  expect(readMode().getAttribute('aria-checked')).toBe('true');
  expect(screenshot().getAttribute('aria-checked')).toBe('false');
});

test('each switch writes only its own half', async () => {
  render(<KeptCopiesGroup />);

  await act(async () => {
    fireEvent.click(screenshot());
  });
  expect(mockSetKeepOnSave).toHaveBeenLastCalledWith({ screenshot: true });

  await act(async () => {
    fireEvent.click(readMode());
  });
  expect(mockSetKeepOnSave).toHaveBeenLastCalledWith({ readMode: false });
});

test('free: both off and disabled whatever is stored, with the upgrade beside them', () => {
  mockKeptCopies = false;
  mockKeepOnSave = { readMode: true, screenshot: true };

  render(<KeptCopiesGroup />);

  for (const sw of [readMode(), screenshot()]) {
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw).toHaveProperty('disabled', true);
  }
  expect(screen.getByRole('link', { name: /upgrade to plus/i }).getAttribute('href')).toBe(
    '/settings/subscription',
  );
  expect(mockSetKeepOnSave).not.toHaveBeenCalled();
});

test('says copies come from the browser extension, not from saving in the web app', () => {
  render(<KeptCopiesGroup />);
  expect(screen.getByText(/browser extension/)).not.toBeNull();
  expect(screen.getByText(/web app can’t keep a copy/)).not.toBeNull();
});
