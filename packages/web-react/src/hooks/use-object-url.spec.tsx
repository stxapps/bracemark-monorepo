/**
 * @jest-environment jsdom
 */
// An object URL pins a full copy of the decrypted bytes until it is revoked or the
// document goes away, and nothing reports one that is never revoked — the image
// paints either way. So what is pinned here is the ledger: every URL minted is
// revoked once nothing shows it, and the one handed to the caller is never a
// revoked one. Every render in this project double-mounts (jest.react-strict-mode.cjs),
// which is the case the hook exists for — a mint in `useMemo` orphans a URL there.

import { renderHook } from '@testing-library/react';

import { useObjectUrl } from './use-object-url';

let minted: Blob[];
let revoked: string[];

const urlOf = (index: number) => `blob:${index}`;
const live = () => minted.map((_, i) => urlOf(i)).filter((url) => !revoked.includes(url));

beforeEach(() => {
  minted = [];
  revoked = [];
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => urlOf(minted.push(blob) - 1),
    revokeObjectURL: (url: string) => void revoked.push(url),
  });
});

const BYTES = new Uint8Array([1, 2, 3]);

it('holds exactly one URL per mounted image, and hands the caller that one', () => {
  const { result } = renderHook(() => useObjectUrl(BYTES));

  expect(live()).toEqual([result.current]);
});

it('revokes it on unmount', () => {
  const { unmount } = renderHook(() => useObjectUrl(BYTES));
  expect(live()).toHaveLength(1);

  unmount();

  expect(live()).toEqual([]);
});

it('revokes the URL it replaces when the bytes change', () => {
  const { result, rerender } = renderHook(({ bytes }) => useObjectUrl(bytes), {
    initialProps: { bytes: BYTES },
  });
  const first = result.current;

  rerender({ bytes: new Uint8Array([4, 5, 6]) });

  expect(result.current).not.toBe(first);
  expect(live()).toEqual([result.current]);
});

it('stops returning the URL once the bytes are gone', () => {
  // An image cleared under a mounted caller: there is no next mint to replace the
  // revoked URL, so the hook has to drop it itself or the <img> keeps a dead src.
  const { result, rerender } = renderHook(
    ({ bytes }: { bytes: Uint8Array | undefined }) => useObjectUrl(bytes),
    { initialProps: { bytes: BYTES as Uint8Array | undefined } },
  );
  expect(result.current).toBeDefined();

  rerender({ bytes: undefined });

  expect(result.current).toBeUndefined();
  expect(live()).toEqual([]);
});

it('mints nothing without bytes', () => {
  const { result } = renderHook(() => useObjectUrl(undefined));

  expect(result.current).toBeUndefined();
  expect(minted).toEqual([]);
});

it('declares the mime it is given, which an SVG cannot paint without', () => {
  renderHook(() => useObjectUrl(BYTES, 'image/svg+xml'));

  expect(minted.at(-1)?.type).toBe('image/svg+xml');
});
