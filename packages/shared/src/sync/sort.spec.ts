import { sortedByName } from './sort';

const item = (id: string, name: string) => ({ id, name });

describe('sortedByName', () => {
  it('orders by name and flips for desc', () => {
    const items = [item('1', 'beta'), item('2', 'alpha'), item('3', 'gamma')];

    expect(sortedByName(items, 'asc').map((i) => i.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortedByName(items, 'desc').map((i) => i.name)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('breaks ties by id in BOTH directions, so a re-sort is stable', () => {
    const items = [item('b', 'same'), item('a', 'same')];

    expect(sortedByName(items, 'asc').map((i) => i.id)).toEqual(['a', 'b']);
    // desc flips the name comparison only — the tie-break stays ascending, so
    // sorting an already-sorted group writes no ranks.
    expect(sortedByName(items, 'desc').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const items = [item('1', 'beta'), item('2', 'alpha')];
    sortedByName(items, 'asc');

    expect(items.map((i) => i.name)).toEqual(['beta', 'alpha']);
  });
});
