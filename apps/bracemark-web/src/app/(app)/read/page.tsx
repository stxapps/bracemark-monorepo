import { Suspense } from 'react';

import { ReaderPage } from './_components/reader-page';

// The reader: one link's kept copies — its read-mode text and its screenshot —
// at `/read?link=<id>`. docs/reader.md is the design; this route is its web half.
//
// A QUERY parameter, not a `[id]` segment, for the reason the links page keeps its
// selection in one: this is a static export, and a dynamic segment would need every
// id at build time. The service worker's precache ignores query strings
// (docs/offline-mode.md), so the one exported `/read` page answers every link —
// offline included, which is the point of a kept copy. The id is a random token,
// never the saved URL.
//
// The Suspense boundary is required above `useSearchParams` in a static export
// (page-provider.tsx in the links route carries the same note).
export default function ReadPage() {
  return (
    <Suspense>
      <ReaderPage />
    </Suspense>
  );
}
