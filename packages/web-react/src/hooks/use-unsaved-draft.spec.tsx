/**
 * @jest-environment jsdom
 */
// The page-wide "is an editor holding unsaved work?" the update pill asks before it
// reloads (docs/offline-mode.md, _update policy_). An editor counts while it is
// mounted AND dirty — no longer once saved (clean) or closed (unmounted).

import { renderHook } from '@testing-library/react';

import { hasUnsavedDrafts, useUnsavedDraft } from './use-unsaved-draft';

jest.mock('../data/db', () => ({ db: {} }));

it('counts a dirty editor until it is clean or gone', () => {
  const first = renderHook(({ dirty }) => useUnsavedDraft(dirty), {
    initialProps: { dirty: false },
  });
  expect(hasUnsavedDrafts()).toBe(false);

  first.rerender({ dirty: true });
  expect(hasUnsavedDrafts()).toBe(true);

  const second = renderHook(() => useUnsavedDraft(true));
  first.rerender({ dirty: false });
  expect(hasUnsavedDrafts()).toBe(true); // the second is still dirty

  second.unmount();
  expect(hasUnsavedDrafts()).toBe(false);
  first.unmount();
});
