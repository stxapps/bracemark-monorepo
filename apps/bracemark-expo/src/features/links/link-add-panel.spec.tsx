import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { LinkItem } from '@stxapps/expo-react';
import { TRASH_ID } from '@stxapps/shared';

import { noteReviewMoment } from '../../lib/review-prompt';
import { LinkAddPanel } from './link-add-panel';

// WHICH submit is a review moment. `lib/review-prompt.ts` decides whether a
// moment asks, and its header promises the moment itself is only ever a save
// that landed — "never after an error, a cancelled flow or a restore from
// Trash; the caller only reaches here on the success branch". That promise is
// one line in this panel, and nothing else holds it: the line sits among four
// early returns and a second door (Restore), a call hoisted above any of them
// lints, typechecks and saves links exactly as before, and the only symptom is
// a rating sheet rising over a duplicate warning on a release build — the one
// build no Maestro run reaches (e2e/mobile/RELEASE.md).
//
// It does NOT cover a save that throws. `onSubmit` is a `void`-ed async handler,
// and a rejection nothing awaits is one jest turns into a failed run (docs/testing.md).
//
// The store seam is mocked whole, as this file's peers do; the form's fields are
// the real ones.
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockExtractNow = jest.fn();
const mockReadLinkByUrlKey = jest.fn();

jest.mock('@stxapps/expo-react', () => ({
  readLinkByUrlKey: (url: string) => mockReadLinkByUrlKey(url),
  useExtraction: () => ({ extractNow: mockExtractNow }),
  useLinkMutations: () => ({ create: mockCreate, update: mockUpdate }),
  useLinkQuota: () => ({ count: 0, max: null, atLimit: false }),
}));
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ selection: { kind: 'all' } }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
// The test renderer mounts no native scroll view, so the panel's animated ref
// never resolves and `useScrollOffset` warns on every mount. Only Note's reveal
// reads the offset, and that is a device behaviour (docs/soft-keyboard.md).
jest.mock('react-native-reanimated', () => ({
  // Not carried by the spread, and without it the default export (`Animated`)
  // is read off the wrong object.
  __esModule: true,
  ...jest.requireActual<typeof import('react-native-reanimated')>('react-native-reanimated'),
  useScrollOffset: () => ({ get: () => 0 }),
}));
jest.mock('../../lib/review-prompt', () => ({ noteReviewMoment: jest.fn() }));
// The pickers behind the collapsed optional section — never opened here, and
// their import graphs reach the rest of the store seam.
jest.mock('../../components/links/list-select', () => ({ ListSelect: () => null }));
jest.mock('../../components/links/tags-field', () => ({ TagsField: () => null }));

const noted = jest.mocked(noteReviewMoment);
const onClose = jest.fn();

const URL = 'https://example.com/a';
const saved = (listId: string): LinkItem => ({
  path: 'links/a.enc',
  url: URL,
  listId,
  tagIds: [],
  createdAt: 1,
  updatedAt: 1,
});

async function submit(url = URL) {
  fireEvent.changeText(screen.getByTestId('add-link-url'), url);
  await act(async () => {
    fireEvent.press(screen.getByTestId('add-link-save'));
  });
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue(saved('my-list'));
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockExtractNow.mockReset();
  mockReadLinkByUrlKey.mockReset().mockResolvedValue(undefined);
  noted.mockClear();
  onClose.mockClear();
  render(<LinkAddPanel onClose={onClose} />);
});

// The positive control: without it, every "notes nothing" below would pass just
// as well against a panel that never reaches the call at all.
it('notes a review moment for a save that landed, after the panel closed', async () => {
  await submit();

  await waitFor(() => expect(noted).toHaveBeenCalledTimes(1));
  expect(mockCreate).toHaveBeenCalledTimes(1);
  // The sheet rises over the list, not over the form (ASK_DELAY_MS counts from here).
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(noted.mock.invocationCallOrder[0]);
});

it('notes nothing for a submit that only armed a warning', async () => {
  await submit('');
  await submit('not a url');
  mockReadLinkByUrlKey.mockResolvedValue(saved('my-list'));
  await submit();

  expect(mockReadLinkByUrlKey).toHaveBeenCalledTimes(1);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(noted).not.toHaveBeenCalled();
});

// Confirm on an armed duplicate IS a save — the user asked for the second copy.
it('notes one moment when the duplicate is confirmed', async () => {
  mockReadLinkByUrlKey.mockResolvedValue(saved('my-list'));
  await submit();
  expect(noted).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.press(screen.getByTestId('add-link-save'));
  });

  await waitFor(() => expect(noted).toHaveBeenCalledTimes(1));
});

it('notes nothing for a restore from Trash', async () => {
  mockReadLinkByUrlKey.mockResolvedValue(saved(TRASH_ID));
  await submit();

  await act(async () => {
    fireEvent.press(screen.getByText('Restore'));
  });

  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(noted).not.toHaveBeenCalled();
});
