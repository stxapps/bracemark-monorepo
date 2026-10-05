import { BUILD_ID_KEY } from '@/lib/build-id';

// `/build.json` — which build these files are (next.config.js). A static file in
// the export, precached like any page (serwist.config.mjs), so what a client reads
// here THROUGH the service worker is the build that worker holds. That is the
// whole point of it being a file rather than a constant in the worker script: the
// worker's answer cannot drift from the pages it serves, because it is one of them.
//
// The update pill compares it with the build the page itself loaded as
// (lib/build-id.ts, components/update-pill.tsx).
export const dynamic = 'force-static';

export function GET() {
  return Response.json({ [BUILD_ID_KEY]: process.env.BUILD_ID ?? '' });
}
