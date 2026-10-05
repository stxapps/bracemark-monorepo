/**
 * @jest-environment jsdom
 */
// The "updated, reload" pill (docs/offline-mode.md, _update policy_). The worker now
// takes over at once, so this is the only thing telling an open tab it runs old code.
// What must hold, none of it visible to any other layer:
//
//   - it shows when a worker holding ANOTHER BUILD takes over a page that was
//     already controlled — never on the first installation, whose clientsClaim also
//     fires `controllerchange`, and never when the worker is only catching up with
//     a page the network already handed the new build;
//   - it shows when the page fails to load one of its own chunks;
//   - the reload never drops an editor's unsaved work unasked, and waits for local
//     saves to commit first;
//   - it steps aside for the update-required banner.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UpdatePill } from './update-pill';

let mockDirty = false;
let mockDbTaken = false;
const mockFlush = jest.fn(() => Promise.resolve());

jest.mock('@stxapps/web-react', () => ({
  flushLocalWrites: () => mockFlush(),
  hasUnsavedDrafts: () => mockDirty,
  useUpdateRequired: () => mockDbTaken,
}));

class FakeContainer extends EventTarget {
  controller: object | null = null;
}
let container: FakeContainer;
const reload = jest.fn();
jest.mock('@/lib/reload-page', () => ({ reloadPage: () => reload() }));

// The build this page loaded as, and what `/build.json` answers through the worker
// in control: a build id, or a failure to read one.
const PAGE_BUILD = 'build-a';
let workerBuild: string | Error;
const fetchBuild = jest.fn(() =>
  workerBuild instanceof Error
    ? Promise.reject(workerBuild)
    : Promise.resolve({ ok: true, json: () => Promise.resolve({ id: workerBuild }) }),
);

beforeEach(() => {
  mockDirty = false;
  mockDbTaken = false;
  mockFlush.mockClear();
  reload.mockClear();
  fetchBuild.mockClear();
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  document.documentElement.setAttribute('data-build', PAGE_BUILD);
  workerBuild = 'build-b';
  globalThis.fetch = fetchBuild as unknown as typeof fetch;
});

// A worker takes control, and the page has asked it which build it holds.
const takeOver = () =>
  act(async () => {
    container.controller = {};
    container.dispatchEvent(new Event('controllerchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const pill = () => screen.queryByRole('status');

it('stays hidden on the first installation', async () => {
  render(<UpdatePill />);

  await takeOver(); // clientsClaim on a page nothing controlled yet

  expect(pill()).toBeNull();
  expect(fetchBuild).not.toHaveBeenCalled();
});

it('shows when a worker holding another build takes over a page the old one controlled', async () => {
  container.controller = {};
  render(<UpdatePill />);

  await takeOver();

  expect(pill()?.textContent).toBe('Bracemark was updated');
});

it('stays hidden when the new worker holds the build this page already is', async () => {
  // A launch after a deploy: the network handed this page the new build while the
  // old worker was still installed, and the new worker has now caught up.
  workerBuild = PAGE_BUILD;
  container.controller = {};
  render(<UpdatePill />);

  await takeOver();

  expect(fetchBuild).toHaveBeenCalledWith('/build.json', { cache: 'no-store' });
  expect(pill()).toBeNull();
});

it('compares the build the page LOADED as, whatever the document says later', async () => {
  // An in-app move under the new worker re-rendered the root layout from the new
  // build's payload: the attribute now names the new build, the code is still old.
  container.controller = {};
  render(<UpdatePill />);
  document.documentElement.setAttribute('data-build', 'build-b');

  await takeOver();

  expect(pill()).not.toBeNull();
});

it.each([
  ['the worker’s build cannot be read', () => (workerBuild = new TypeError('Failed to fetch'))],
  ['the worker holds no build file', () => (workerBuild = '')],
  ['the page carries no build', () => document.documentElement.removeAttribute('data-build')],
])('shows when %s', async (_name, arrange) => {
  arrange();
  container.controller = {};
  render(<UpdatePill />);

  await takeOver();

  expect(pill()).not.toBeNull();
});

it('shows after the first installation once a later worker takes over', async () => {
  render(<UpdatePill />);
  await takeOver();
  await takeOver();

  expect(pill()).not.toBeNull();
});

it('shows when the page fails to load one of its own chunks', () => {
  render(<UpdatePill />);

  act(() => {
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', {
      value: new TypeError('Failed to fetch dynamically imported module: /_next/x.js'),
    });
    window.dispatchEvent(event);
  });

  expect(pill()).not.toBeNull();
});

it('reloads after local saves commit when nothing is unsaved', async () => {
  container.controller = {};
  render(<UpdatePill />);
  await takeOver();

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(mockFlush).toHaveBeenCalledTimes(1);
});

it('asks before discarding an unsaved editor, and keeps it on "Keep editing"', async () => {
  mockDirty = true;
  container.controller = {};
  render(<UpdatePill />);
  await takeOver();

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(reload).not.toHaveBeenCalled();
});

it('reloads on an explicit discard', async () => {
  mockDirty = true;
  container.controller = {};
  render(<UpdatePill />);
  await takeOver();

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard and reload' }));

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('steps aside for the update-required banner', async () => {
  mockDbTaken = true;
  container.controller = {};
  render(<UpdatePill />);
  await takeOver();

  expect(pill()).toBeNull();
});
