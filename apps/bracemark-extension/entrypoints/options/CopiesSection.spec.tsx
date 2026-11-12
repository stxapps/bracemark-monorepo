import { act, fireEvent, render, screen } from '@testing-library/react';

import { PAYWALL_COPY } from '@stxapps/react';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import { CopiesSection } from './CopiesSection';

import { WEB_APP_URL } from '@/utils/web-app-url';

// The kept-copies setting on the client every switch of it governs. What matters is
// what each switch WRITES and what an unentitled account sees — the stored value and
// the plan are separate facts:
//
//   - all three switches are here (bracemark-web keeps only the images one, expo
//     only what the phone takes), and each writes only its own field;
//   - on free there are no switches, only the upgrade into the web app's
//     Subscription section, and nothing is rewritten, so a returning subscriber
//     keeps their choice.

let mockKeptCopies = true;
let mockKeepOnSave = { readMode: true, readModeImages: true, screenshot: false };
const mockSetKeepOnSave = jest.fn(async (_patch: object) => undefined);

jest.mock('@stxapps/web-react', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  useSettings: () => ({ keepOnSave: mockKeepOnSave }),
  useSettingMutations: () => ({ setKeepOnSave: mockSetKeepOnSave }),
}));

const readMode = () => screen.getByRole('switch', { name: 'Keep a read-mode copy when you save' });
const screenshot = () => screen.getByRole('switch', { name: 'Keep a screenshot when you save' });
const images = () => screen.getByRole('switch', { name: 'Include images in read-mode copies' });

let fake: FakeBrowser;

beforeEach(() => {
  fake = installFakeBrowser();
  mockKeptCopies = true;
  mockKeepOnSave = { readMode: true, readModeImages: true, screenshot: false };
  mockSetKeepOnSave.mockClear();
});

test('shows the resolved setting: read mode on, its images on, screenshot off', () => {
  render(<CopiesSection />);
  expect(readMode().getAttribute('aria-checked')).toBe('true');
  expect(images().getAttribute('aria-checked')).toBe('true');
  expect(screenshot().getAttribute('aria-checked')).toBe('false');
});

test('each switch writes only its own field', async () => {
  render(<CopiesSection />);

  await act(async () => {
    fireEvent.click(screenshot());
  });
  expect(mockSetKeepOnSave).toHaveBeenLastCalledWith({ screenshot: true });

  await act(async () => {
    fireEvent.click(readMode());
  });
  expect(mockSetKeepOnSave).toHaveBeenLastCalledWith({ readMode: false });

  await act(async () => {
    fireEvent.click(images());
  });
  expect(mockSetKeepOnSave).toHaveBeenLastCalledWith({ readModeImages: false });
});

test('free: no switches, only the upgrade into the web app, and nothing written', () => {
  mockKeptCopies = false;
  mockKeepOnSave = { readMode: true, readModeImages: true, screenshot: true };

  render(<CopiesSection />);

  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.getByText(PAYWALL_COPY.keptCopies.description)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /upgrade to plus/i }));
  expect(fake.tabs.create).toHaveBeenCalledWith({ url: `${WEB_APP_URL}/settings/subscription` });
  expect(mockSetKeepOnSave).not.toHaveBeenCalled();
});

test('a failed write is announced, and the switches stay live', async () => {
  mockSetKeepOnSave.mockRejectedValueOnce(new Error('No active account'));
  render(<CopiesSection />);

  await act(async () => {
    fireEvent.click(screenshot());
  });

  expect(screen.getByRole('alert').textContent).toBe('No active account');
  expect(screenshot()).toHaveProperty('disabled', false);
});
