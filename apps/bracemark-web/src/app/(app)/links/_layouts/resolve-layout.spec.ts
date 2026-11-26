// The table's fallbacks. Each failure is quiet: a free account handed a Plus view,
// a phone handed a table that scrolls sideways, or — the other way — a Plus user
// whose table never comes back after an upgrade because something wrote `list`
// over the choice. resolveLayout only READS, which is what keeps that last one
// from happening.

import { TABLE_MIN_PANE_WIDTH } from '@stxapps/shared';

import { resolveLayout } from './resolve-layout';

describe('resolveLayout', () => {
  it('renders the table for an entitled account on a wide pane', () => {
    expect(resolveLayout('table', true, TABLE_MIN_PANE_WIDTH)).toBe('table');
  });

  it('falls back to the list without the entitlement', () => {
    expect(resolveLayout('table', false, 1600)).toBe('list');
  });

  it('falls back to the list on a narrow pane', () => {
    expect(resolveLayout('table', true, TABLE_MIN_PANE_WIDTH - 1)).toBe('list');
  });

  // Unmeasured: assume it fits, so a wide window doesn't flash the list first.
  it('assumes a table fits before the pane is measured', () => {
    expect(resolveLayout('table', true, 0)).toBe('table');
  });

  it('keeps card and list, and renders an unknown layout as the list', () => {
    expect(resolveLayout('card', false, 300)).toBe('card');
    expect(resolveLayout('list', true, 1600)).toBe('list');
    expect(resolveLayout('timeline', true, 1600)).toBe('list');
  });
});
