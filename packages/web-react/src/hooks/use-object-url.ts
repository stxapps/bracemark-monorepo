'use client';

// Decrypted bytes as an <img>-ready object URL, with the URL's whole lifetime —
// mint AND revoke — owned by ONE effect. Returns undefined while there are no
// bytes, and for the one commit between bytes landing and the effect running (the
// caller is already painting its placeholder then).
//
// The mint is in the effect, not in a `useMemo` beside a revoking effect, which is
// what every caller did before this hook existed. That split tied the two halves to
// different lifetimes — the URL to the memo's cache, its revocation to the effect —
// and they come apart whenever React runs one without the other:
//
//  - StrictMode calls a memo's calculation TWICE and keeps one result, so every
//    image minted a second URL nothing ever revoked. Dev-only, but it is a full
//    copy of the bytes per image scrolled into view, held until reload.
//  - A render that never commits minted a URL whose effect never ran.
//  - Anything that re-runs effects while keeping the memo (an <Activity> reveal)
//    revoked the URL and left a mounted <img> pointing at it.
//
// An effect's setup and cleanup are always paired, so none of the three can happen
// here. The cost is one extra render of the (leaf) caller per image.
//
// `type` is the Blob's mime. Raster bytes don't need one — an <img> sniffs them —
// but an SVG does (use-favicon-url.ts has the specimen).

import { useEffect, useState } from 'react';

export function useObjectUrl(bytes: Uint8Array | undefined, type?: string): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!bytes) return;
    const minted = URL.createObjectURL(new Blob([bytes as BlobPart], type ? { type } : undefined));
    setUrl(minted);
    return () => {
      URL.revokeObjectURL(minted);
      // So the hook never goes on returning a URL it has revoked: bytes that go
      // AWAY (an image cleared under a mounted caller) have no next mint to
      // replace it. When they merely change, this and the next setup's set land
      // in one render.
      setUrl(undefined);
    };
  }, [bytes, type]);

  return url;
}
