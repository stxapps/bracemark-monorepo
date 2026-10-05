/**
 * @jest-environment jsdom
 */
// The foreground update check (docs/offline-mode.md, _when the browser checks for a
// new build_). A window that never reloads never navigates, so without this it
// never learns of a deploy — and nothing else reports that: the app keeps working,
// on a build that gets older every week.

import {
  SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS,
  watchForServiceWorkerUpdates,
} from './service-worker-update-check';

const update = jest.fn(() => Promise.resolve());
let registration: { update: typeof update } | undefined;
let visibility: DocumentVisibilityState;
let online: boolean;
let stop: () => void;

const show = async () => {
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve(); // getRegistration()
};
const hide = () => {
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
};
const wait = (ms: number) => jest.advanceTimersByTime(ms);

beforeEach(() => {
  jest.useFakeTimers();
  update.mockClear();
  registration = { update };
  visibility = 'visible';
  online = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: () => Promise.resolve(registration) },
  });
  stop = watchForServiceWorkerUpdates();
});

afterEach(() => {
  stop();
  jest.useRealTimers();
});

it('checks when the window returns after the interval, and not again until the next one', async () => {
  // The load was a check, so a return inside the first interval is not.
  wait(SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS - 1);
  hide();
  await show();
  expect(update).not.toHaveBeenCalled();

  wait(1);
  hide();
  await show();
  expect(update).toHaveBeenCalledTimes(1);

  hide();
  await show();
  expect(update).toHaveBeenCalledTimes(1);

  wait(SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS);
  hide();
  await show();
  expect(update).toHaveBeenCalledTimes(2);
});

it('does not check when the window is hidden', async () => {
  wait(SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS);

  hide();
  await Promise.resolve();

  expect(update).not.toHaveBeenCalled();
});

it('skips an offline return without spending the interval', async () => {
  wait(SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS);
  online = false;
  hide();
  await show();
  expect(update).not.toHaveBeenCalled();

  online = true;
  hide();
  await show();
  expect(update).toHaveBeenCalledTimes(1);
});

it('stops checking once torn down', async () => {
  wait(SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS);
  stop();

  hide();
  await show();

  expect(update).not.toHaveBeenCalled();
});
