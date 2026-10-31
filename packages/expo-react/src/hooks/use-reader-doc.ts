import { useEffect, useState } from 'react';
import { File } from 'expo-file-system';

import type { ReaderDoc } from '@stxapps/shared';

import { decodeReaderDoc } from '../lib/reader-doc-bytes';
import { useImageFileUri } from './use-image-file-uri';

// A link's read-mode copy, for the reader — web-react's useReaderDoc, on expo's
// store. Same states (`none` / `loading` / `ready` / `unreadable`); see there for
// what each means.
//
// The blob is a decrypted file on disk here, not bytes in a table, so the first half
// is useImageFileUri: the file's uri when it is resident, `null` when it isn't (and a
// request to FileContentProvider to fetch it), `undefined` while that is being
// asked. Its name says "image" because previews were its first reader; nothing in it
// is image-specific. Then the bytes are read off disk and decoded (lib/reader-doc-
// bytes.ts) — keyed on the uri, so a stale decode never shows for a newer copy.
export type ReaderDocState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; doc: ReaderDoc }
  | { status: 'unreadable' };

export function useReaderDoc(fileId: string | undefined): ReaderDocState {
  const uri = useImageFileUri(fileId);
  const [decoded, setDecoded] = useState<{ uri: string; doc: ReaderDoc | undefined } | null>(null);

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    new File(uri)
      .bytes()
      .then(
        (bytes) => decodeReaderDoc(bytes),
        () => undefined,
      )
      .then((doc) => {
        if (!cancelled) setDecoded({ uri, doc });
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (!fileId) return { status: 'none' };
  if (!uri || decoded?.uri !== uri) return { status: 'loading' };
  return decoded.doc ? { status: 'ready', doc: decoded.doc } : { status: 'unreadable' };
}
