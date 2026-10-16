import type { List, Tag } from '../sync/entities';
import { LISTS_PREFIX, pathFromId, TAGS_PREFIX } from '../sync/paths';
import { ranksBetween } from '../sync/rank';
import { TREE_MAX_DEPTH } from '../sync/tree';
import { pastMaxDepthCounts } from './export-run';

// The backup receipt's counters are asked of the restore's own rule, so these
// pin only the wiring — lists counted as lists, tags as tags, nothing at the
// limit — and leave the rule itself to backup.spec.ts (flattenBackupTree).
describe('pastMaxDepthCounts', () => {
  const [RANK] = ranksBetween(null, null, 1);
  const LIMIT = TREE_MAX_DEPTH;

  // `length` ids chained root-first: c0 is the root, c{length-1} the deepest.
  function chain<T extends List | Tag>(kind: 'list' | 'tag', length: number) {
    return Array.from({ length }, (_, i) => {
      const id = `c${i}`;
      return {
        path: pathFromId(id, kind === 'list' ? LISTS_PREFIX : TAGS_PREFIX),
        entity: { id, name: id, parentId: i === 0 ? null : `c${i - 1}`, rank: RANK } as T,
      };
    });
  }

  it('counts nothing for chains of exactly the limit', () => {
    expect(pastMaxDepthCounts(chain('list', LIMIT), chain('tag', LIMIT))).toEqual({
      pastMaxDepthListCount: 0,
      pastMaxDepthTagCount: 0,
    });
  });

  it('counts lists and tags past the limit separately', () => {
    expect(pastMaxDepthCounts(chain('list', LIMIT + 2), chain('tag', LIMIT + 1))).toEqual({
      pastMaxDepthListCount: 2,
      pastMaxDepthTagCount: 1,
    });
  });
});
