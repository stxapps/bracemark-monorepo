import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { touchClaim } from '../../testing/scroll-claim';
import { LinkDestroyConfirm } from './link-destroy-confirm';

// The links page's delete confirm. Its body is all Text — a title that
// interpolates a link's TITLE, which is unbounded — in the one alert dialog with
// a scroller, under the AlertDialog overlay's Pressable. Claimed by that overlay,
// a drag on the message does not scroll on iOS, and a long title is the case
// that needs the scroll (components/ui/scroll-claim.tsx). jest cannot drag; it
// can pin where the touch is claimed (testing/scroll-claim.ts).

const mockDestroyMany = jest.fn<Promise<void>, [unknown[]]>();
jest.mock('@stxapps/expo-react', () => ({
  useLinkMutations: () => ({ destroyMany: mockDestroyMany }),
}));

type Doomed = { id: string; title: string; url: string };
let mockDestroying: Doomed[] | null = null;
const mockCloseDestroy = jest.fn();
const mockExitBulkEdit = jest.fn();
jest.mock('./view-state-provider', () => ({
  useLinksViewState: () => ({
    destroying: mockDestroying,
    closeDestroy: mockCloseDestroy,
    exitBulkEdit: mockExitBulkEdit,
  }),
}));

const doomed = (id: string, title: string): Doomed => ({
  id,
  title,
  url: `https://${id}.example.com/page`,
});

beforeEach(() => {
  mockDestroying = null;
  mockDestroyMany.mockReset().mockResolvedValue(undefined);
  mockCloseDestroy.mockReset();
  mockExitBulkEdit.mockReset();
});

const mount = () =>
  render(
    <>
      <LinkDestroyConfirm />
      {/* The dialog portals to the default host the root layout mounts. */}
      <PortalHost />
    </>,
  );

test('renders nothing until a delete is requested', () => {
  mount();
  expect(screen.queryByText('Delete permanently?')).toBeNull();
});

test('claims a touch on the message inside its scroller, not at the overlay', () => {
  mockDestroying = [doomed('a', 'A very long title '.repeat(40))];
  mount();

  expect(touchClaim(screen.getByText(/will be removed from all your devices/))).toBe('inside');
  expect(touchClaim(screen.getByText('Delete permanently?'))).toBe('inside');
});

test('names one link by its title, falling back to its host, and counts several', () => {
  mockDestroying = [doomed('a', 'Reading')];
  const view = mount();
  expect(screen.getByText(/“Reading” and its saved content/)).toBeTruthy();

  mockDestroying = [doomed('b', '')];
  view.rerender(
    <>
      <LinkDestroyConfirm />
      <PortalHost />
    </>,
  );
  expect(screen.getByText(/“b\.example\.com” and its saved content/)).toBeTruthy();

  mockDestroying = [doomed('a', 'Reading'), doomed('b', 'Other')];
  view.rerender(
    <>
      <LinkDestroyConfirm />
      <PortalHost />
    </>,
  );
  expect(screen.getByText(/2 links and their saved content/)).toBeTruthy();
});

test('deletes the whole selection in one call, then closes and leaves bulk edit', async () => {
  mockDestroying = [doomed('a', 'Reading'), doomed('b', 'Other')];
  mount();

  await act(async () => {
    fireEvent.press(screen.getByTestId('link-destroy-submit'));
  });

  expect(mockDestroyMany).toHaveBeenCalledTimes(1);
  expect(mockDestroyMany).toHaveBeenCalledWith(mockDestroying);
  expect(mockCloseDestroy).toHaveBeenCalledTimes(1);
  expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
});
