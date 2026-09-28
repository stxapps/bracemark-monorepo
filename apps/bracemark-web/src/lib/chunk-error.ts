// Did this page fail to load a piece of ITS OWN build? That is what an open tab
// meets after a newer build's worker took over (docs/offline-mode.md, _version
// skew_): the page asks for a chunk its build names, and offline the new worker no
// longer holds it. Online, hosting keeps every `_next/` file, so this is rare; the
// answer either way is the new build, which the update pill reloads into.
//
// Matched by name and by message, because the loaders word it differently:
// webpack's `ChunkLoadError` ("Loading chunk 123 failed"), and the browsers'
// native dynamic-import failures (Chrome "Failed to fetch dynamically imported
// module", Safari "Importing a module script failed", Firefox "error loading
// dynamically imported module").
const CHUNK_MESSAGE =
  /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'ChunkLoadError' || (typeof message === 'string' && CHUNK_MESSAGE.test(message));
}
