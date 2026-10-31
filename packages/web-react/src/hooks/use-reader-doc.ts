'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import type { ReaderDoc } from '@stxapps/shared';

import { useFileContent } from '../contexts/file-content-provider';
import { readFileBytes } from '../data/queries';
import { decodeReaderDoc } from '../lib/reader-doc-bytes';

// A link's read-mode copy, for the reader: the `files/{readModeId}.enc` blob made
// resident, then gunzipped and parsed (lib/reader-doc-bytes.ts).
//
// The same two halves as useImageFileUrl — observe the bytes with a live read, ask
// FileContentProvider for them when they aren't local — with two differences that
// follow from who is asking. There is no settle delay: a row asks on mount and a
// fast scroll mounts dozens, but the reader is opened by a deliberate tap, so the
// request goes out at once. And the bytes are DECODED here rather than handed to an
// `<img>`, which makes the decode async and this hook a small state machine.
//
//   loading    — the blob isn't local yet (being fetched), or is being decoded.
//                Offline with a copy this device never downloaded, it stays here:
//                the provider retries on a later mount, and the reader says so.
//   ready      — `doc` is the copy.
//   unreadable — the bytes are here and are not a copy (decodeReaderDoc's three
//                failures). Never a throw: one bad blob must not take the screen.
//   none       — the link has no read-mode copy (`fileId` undefined).
export type ReaderDocState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; doc: ReaderDoc }
  | { status: 'unreadable' };

const LOADING = Symbol('loading');

export function useReaderDoc(fileId: string | undefined): ReaderDocState {
  const { requestFileContent } = useFileContent();

  const bytes = useLiveQuery(
    () => (fileId ? readFileBytes(fileId) : Promise.resolve(undefined)),
    [fileId],
    LOADING as Uint8Array | undefined | typeof LOADING,
  );

  // `undefined` is exactly "resolved with nothing local" — the sentinel and present
  // bytes both skip. The provider's single-flight and missing memo make a repeat a
  // no-op, so this can't tight-loop.
  useEffect(() => {
    if (fileId && bytes === undefined) requestFileContent(fileId);
  }, [fileId, bytes, requestFileContent]);

  // Keyed on the bytes it decoded, so a stale decode can never be shown for a
  // newer blob (a re-capture landing while the reader is open).
  const [decoded, setDecoded] = useState<{
    bytes: Uint8Array;
    doc: ReaderDoc | undefined;
  } | null>(null);

  useEffect(() => {
    if (!(bytes instanceof Uint8Array)) return;
    let cancelled = false;
    void decodeReaderDoc(bytes).then((doc) => {
      if (!cancelled) setDecoded({ bytes, doc });
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (!fileId) return { status: 'none' };
  if (!(bytes instanceof Uint8Array) || decoded?.bytes !== bytes) return { status: 'loading' };
  return decoded.doc ? { status: 'ready', doc: decoded.doc } : { status: 'unreadable' };
}
