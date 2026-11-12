'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { decodeReaderImages } from '@stxapps/shared';

import { useFileContent } from '../contexts/file-content-provider';
import { readFileBytes } from '../data/queries';

// The images a read-mode copy keeps, for the reader: the pack
// (`files/{readModeImagesId}.enc`, @stxapps/shared reader/reader-images.ts) made
// resident, split, and each image handed back as an object URL under the key its
// figure block names.
//
// The same two halves as useReaderDoc — a live read of the bytes, a request to
// FileContentProvider when they aren't local, no settle delay because the reader is a
// deliberate open. What differs is that the answer is OPTIONAL to the screen: the text
// renders without it, and every figure already knows its size, so `images` is an
// empty map until the pack is in and the figures fill as it lands. `settled` says
// which empty it is: false while the pack may still arrive (the reader holds each
// figure's space), true once it has been read — or can't be, a pack that is damaged
// or in a newer format — and when the copy has no pack at all. Settled with a key
// missing, a figure falls back to its words.
//
// The object URLs live exactly as long as the bytes they were minted from, in one
// effect, for the reasons use-object-url.ts gives. They are `blob:` URLs of bytes
// decrypted on this device; nothing here can make a request to the saved site. Each one's
// type is what the bytes ARE (decodeReaderImages sniffs; an entry that is not a raster image
// is dropped), never a type the pack claims.
export interface ReaderImageView {
  url: string;
  width: number;
  height: number;
}

export interface ReaderImagesState {
  images: ReadonlyMap<string, ReaderImageView>;
  settled: boolean;
}

const NONE: ReadonlyMap<string, ReaderImageView> = new Map();
const LOADING = Symbol('loading');

export function useReaderImages(fileId: string | undefined): ReaderImagesState {
  const { requestFileContent } = useFileContent();

  const bytes = useLiveQuery(
    () => (fileId ? readFileBytes(fileId) : Promise.resolve(undefined)),
    [fileId],
    LOADING as Uint8Array | undefined | typeof LOADING,
  );

  useEffect(() => {
    if (fileId && bytes === undefined) requestFileContent(fileId);
  }, [fileId, bytes, requestFileContent]);

  // Keyed on the bytes it was read from, so a stale pack is never shown as settled
  // for a newer one (a re-capture landing while the reader is open).
  const [read, setRead] = useState<{
    bytes: Uint8Array;
    images: ReadonlyMap<string, ReaderImageView>;
  } | null>(null);

  useEffect(() => {
    if (!(bytes instanceof Uint8Array)) return;
    const entries = decodeReaderImages(bytes);
    if (!entries) {
      setRead({ bytes, images: NONE });
      return;
    }
    const minted = new Map<string, ReaderImageView>();
    for (const { key, type, width, height, bytes: image } of entries) {
      const url = URL.createObjectURL(new Blob([image as BlobPart], { type }));
      minted.set(key, { url, width, height });
    }
    setRead({ bytes, images: minted });
    return () => {
      for (const { url } of minted.values()) URL.revokeObjectURL(url);
      setRead(null);
    };
  }, [bytes]);

  if (!fileId) return { images: NONE, settled: true };
  if (!(bytes instanceof Uint8Array) || read?.bytes !== bytes) {
    return { images: NONE, settled: false };
  }
  return { images: read.images, settled: true };
}
