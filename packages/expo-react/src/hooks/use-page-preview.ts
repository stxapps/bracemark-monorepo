import { useCallback } from 'react';
import type { File } from 'expo-file-system';

import { type CollectedMeta, selectTitleImage } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { linkIdOf, type LinkItem } from '../data/queries';
import { storePagePreview } from '../data/store-page-preview';
import { fetchPreviewImageFile, previewFileFromBytes } from '../lib/device-extraction';

// _Update preview_ on the capture screen: a link's title and preview image, taken from
// the page open in its WebView (the app's features/capture/capture-screen.tsx).
// docs/link-extraction-keep.md, _per client_, the capture screen.
//
// The page reports its candidates (web-react lib/page-meta.ts, the collector the
// browser extension injects too); WHICH wins is `selectTitleImage`'s call, here, as on
// every tier. The image is fetched inside the page first — with the site's session, so
// an image behind its sign-in is reachable — and natively when the page could not (an
// image host that refuses a cross-origin read). Either way the bytes go through the one
// preview pipeline (`previewFileFromBytes`): sniffed, measured and capped.
//
// Not plan-gated HERE: the gate is the capture screen's, which offers this only on a
// plan with `keptCopies` (docs/reader.md, _the way in_) — a preview the drain fetches
// is free on every plan, this hand-asked re-read of one is not. Not subject to the
// device's fetch mode either — this is an explicit ask on a page the user has open, like _Keep read
// mode_ on the same screen (use-kept-copy-mutations.ts).

export interface PagePreviewInput {
  // The page's address as the page reported it — the base its relative image resolves
  // against.
  href: string;
  collected: CollectedMeta;
  // Fetch an image inside the page; undefined (or a rejection) when it couldn't.
  fetchFromPage: (url: string) => Promise<Uint8Array | undefined>;
}

export interface PagePreviewOutcome {
  title: boolean;
  image: boolean;
}

function deleteQuietly(file: File | undefined): void {
  try {
    if (file?.exists) file.delete();
  } catch {
    // A leftover is the sign-out sweep's (data/cache-files.ts).
  }
}

export function usePagePreview(): {
  updatePreviewFromPage: (link: LinkItem, input: PagePreviewInput) => Promise<PagePreviewOutcome>;
} {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const updatePreviewFromPage = useCallback(
    async (link: LinkItem, { href, collected, fetchFromPage }: PagePreviewInput) => {
      if (!username) throw new Error('usePagePreview: no active account');
      let base: URL;
      try {
        base = new URL(href);
      } catch {
        return { title: false, image: false };
      }
      const { title, imageUrl } = selectTitleImage(collected, base);

      let image: File | undefined;
      try {
        if (imageUrl) {
          const bytes = await fetchFromPage(imageUrl).catch(() => undefined);
          image = bytes ? await previewFileFromBytes(bytes) : undefined;
          image ??= await fetchPreviewImageFile(imageUrl);
        }
        const stored = await storePagePreview(username, linkIdOf(link), { title, image });
        if (stored) requestSync();
        return { title: stored && Boolean(title), image: stored && Boolean(image) };
      } finally {
        deleteQuietly(image);
      }
    },
    [username, requestSync],
  );

  return { updatePreviewFromPage };
}
