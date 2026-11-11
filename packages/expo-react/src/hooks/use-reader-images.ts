import { useEffect, useState } from 'react';
import { File } from 'expo-file-system';

import { bytesToBase64, decodeReaderImages } from '@stxapps/shared';

import { useImageFileUri } from './use-image-file-uri';

// The images a read-mode copy keeps, for the reader — web-react's useReaderImages, on
// expo's store (that header has what `images` and `settled` mean, and why a pack that
// can't be read is an empty map rather than an error).
//
// The pack is one decrypted file on disk; it is read once and split, and each image
// is handed to expo-image as a `data:` URI. Not a file each: that would be thirty
// plaintext files to name, sweep and account for on sign-out (data/cache-files.ts),
// to save holding a few hundred KB of strings while one article is open.
export interface ReaderImageView {
  uri: string;
  width: number;
  height: number;
}

export interface ReaderImagesState {
  images: ReadonlyMap<string, ReaderImageView>;
  settled: boolean;
}

const NONE: ReadonlyMap<string, ReaderImageView> = new Map();

export function useReaderImages(fileId: string | undefined): ReaderImagesState {
  const uri = useImageFileUri(fileId);
  const [read, setRead] = useState<{
    uri: string;
    images: ReadonlyMap<string, ReaderImageView>;
  } | null>(null);

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    new File(uri)
      .bytes()
      .then(
        (bytes) => decodeReaderImages(bytes),
        () => undefined,
      )
      .then((entries) => {
        if (cancelled) return;
        const images = new Map<string, ReaderImageView>();
        for (const { key, type, width, height, bytes } of entries ?? []) {
          images.set(key, { uri: `data:${type};base64,${bytesToBase64(bytes)}`, width, height });
        }
        setRead({ uri, images });
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (!fileId) return { images: NONE, settled: true };
  if (!uri || read?.uri !== uri) return { images: NONE, settled: false };
  return { images: read.images, settled: true };
}
