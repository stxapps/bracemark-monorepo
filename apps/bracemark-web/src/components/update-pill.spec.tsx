/**
 * @jest-environment jsdom
 */
// The "updated, reload" pill (docs/offline-mode.md, _update policy_). The worker now
// takes over at once, so this is the only thing telling an open tab it runs old code.
// What must hold, none of it visible to any other layer:
//
//   - it shows when a NEW worker takes over a page that was already controlled —
//     never on the first installation, whose clientsClaim also fires
//     `controllerchange`;
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

beforeEach(() => {
  mockDirty = false;
  mockDbTaken = false;
  mockFlush.mockClear();
  reload.mockClear();
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
});

const takeOver = () =>
  act(() => {
    container.controller = {};
    container.dispatchEvent(new Event('controllerchange'));
  });

const pill = () => screen.queryByRole('status');

it('stays hidden on the first installation', () => {
  render(<UpdatePill />);

  takeOver(); // clientsClaim on a page nothing controlled yet

  expect(pill()).toBeNull();
});

it('shows when a new worker takes over a page the old one controlled', () => {
  container.controller = {};
  render(<UpdatePill />);

  takeOver();

  expect(pill()?.textContent).toBe('Bracemark was updated');
});

it('shows after the first installation once a later worker takes over', () => {
  render(<UpdatePill />);
  takeOver();
  takeOver();

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
  takeOver();

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(mockFlush).toHaveBeenCalledTimes(1);
});

it('asks before discarding an unsaved editor, and keeps it on "Keep editing"', async () => {
  mockDirty = true;
  container.controller = {};
  render(<UpdatePill />);
  takeOver();

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
  takeOver();

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard and reload' }));

  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('steps aside for the update-required banner', () => {
  mockDbTaken = true;
  container.controller = {};
  render(<UpdatePill />);
  takeOver();

  expect(pill()).toBeNull();
});
