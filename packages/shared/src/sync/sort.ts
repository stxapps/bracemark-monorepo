// Alphabetical re-sort for the rank model — what the "Sort A → Z" command on the
// Lists and Tags tables hands to `reorder`. Pure and entity-agnostic like tree.ts
// beside it: it knows only `name` and `id`, so lists, sub-lists and tags all use
// the one copy, on both platforms.
//
// Ties break by `id` so the order is deterministic and stable across re-sorts —
// without it, two entities with the same name could swap on every invocation and
// each swap is a rank write that syncs.

export type SortDir = 'asc' | 'desc';

// Case-insensitive by name (localeCompare); `desc` flips the name comparison
// only, never the id tie-break. Returns a new array — the input is a live store
// read at every call site.
export function sortedByName<T extends { id: string; name: string }>(
  items: T[],
  dir: SortDir,
): T[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return dir === 'asc' ? byName : -byName;
    return a.id.localeCompare(b.id);
  });
}
