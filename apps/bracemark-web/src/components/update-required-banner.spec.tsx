/**
 * @jest-environment jsdom
 */
// The update-required banner (docs/offline-mode.md, _version skew_). A newer build
// in another tab has taken this origin's database, so this tab can't save. What
// must hold, none of it visible to the e2e runs (VERSION-SKEW-WEB-001/002 stop at
// the banner showing over the draft):
//
//   - the tab never reloads by itself — reloading is the explicit discard;
//   - with the newer build's worker still WAITING, the reload waits for it to take
//     over, or the old shell is served again and meets the upgraded database in a
//     loop;
//   - the button is never stranded: a handover that doesn't report, or no worker to
//     hand over to at all, still reloads.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UpdateRequiredBanner } from './update-required-banner';

let mockRequired = true;
let mockSignal: (() => void) | undefined;

// The real hook over a fake signal: subscribe captures the listener, and the
// snapshot reads mockRequired — so a spec raises the signal by setting both.
jest.mock('@stxapps/web-react', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (listener: () => void) => {
    mockSignal = listener;
    return () => undefined;
  };
  return {
    useUpdateRequired: () => useSyncExternalStore(subscribe, () => mockRequired),
  };
});

class FakeContainer extends EventTarget {
  getRegistration = jest.fn(() => Promise.resolve(registration));
}
let container: FakeContainer;
let registration: { waiting: { postMessage: jest.Mock } | null } | undefined;
const reload = jest.fn();
jest.mock('@/lib/reload-page', () => ({ reloadPage: () => reload() }));

beforeEach(() => {
  mockRequired = true;
  mockSignal = undefined;
  reload.mockClear();
  registration = { waiting: null };
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
});

afterEach(() => {
  jest.useRealTimers();
});

const pressReload = () => fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

it('appears when the signal arrives, and never reloads by itself', () => {
  mockRequired = false;
  render(<UpdateRequiredBanner />);
  expect(screen.queryByRole('alert')).toBeNull();

  act(() => {
    mockRequired = true;
    mockSignal?.();
  });

  expect(screen.getByRole('alert').textContent).toContain('Bracemark was updated in another tab');
  expect(reload).not.toHaveBeenCalled();
});

it('reloads at once when no worker is waiting', async () => {
  render(<UpdateRequiredBanner />);

  pressReload();

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('reloads where there is no service worker at all', async () => {
  // An insecure context — a phone on the LAN over plain http (docs/device-testing.md).
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  render(<UpdateRequiredBanner />);

  pressReload();

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('asks a waiting worker to take over, and reloads only once it has', async () => {
  const waiting = { postMessage: jest.fn() };
  registration = { waiting };
  render(<UpdateRequiredBanner />);

  pressReload();
  await waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
  expect(reload).not.toHaveBeenCalled();

  act(() => {
    container.dispatchEvent(new Event('controllerchange'));
  });

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('reloads anyway when the handover never reports', async () => {
  jest.useFakeTimers();
  const waiting = { postMessage: jest.fn() };
  registration = { waiting };
  render(<UpdateRequiredBanner />);

  pressReload();
  await waitFor(() => expect(waiting.postMessage).toHaveBeenCalled());
  expect(reload).not.toHaveBeenCalled();

  await act(() => jest.runOnlyPendingTimersAsync());

  expect(reload).toHaveBeenCalledTimes(1);
});
