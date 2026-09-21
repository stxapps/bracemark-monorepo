/**
 * @jest-environment jsdom
 */
// Specs for the settings read — the hook that folds TWO sources (the synced
// `settings/general.enc` and the device-local `localSettings` row) into the one value the
// app renders. Three rules here are silent when broken:
//
//   - THE SOURCE RESOLUTION. `linksLayoutSource` / `themeSource` are device-local and
//     decide which source is applied. Read the wrong one and a device that opted out of
//     the synced layout silently starts following it again — no error, just the user's
//     deliberate choice quietly reverted on their next visit.
//   - THE FORWARD-COMPAT PASSTHROUGH. `linksLayout`, `sortOn` and `sortOrder` are typed
//     `string`, not their enums, precisely so a value written by a NEWER client reaches
//     consumers INTACT and round-trips back untouched. Coercing an unknown value to the
//     default here looks harmless and is not: this device would then write the coerced
//     value back over the newer device's choice on the next settings edit.
//   - THE THEME'S IDENTITY STABILITY. `coerceThemeState` allocates a fresh object every
//     call, so an unmemoized `theme` changes identity every render. ThemeProvider deps on
//     it, which makes that a churned effect at best and a render loop for any consumer
//     that both deps on it and sets state from it.
//
// The two reads are stubbed at the source modules (a liveQuery stand-in runs the queriers
// for real); everything the hook itself does — the resolution, the defaults, the coercion,
// the memo — is the real code.

import { act, renderHook } from '@testing-library/react';

import { DEFAULT_THEME, type ThemeState } from '@stxapps/shared';

import type { LocalSettingsRecord } from '../data/db';
import { useSettings } from './use-settings';

let mockGeneral: Record<string, unknown> | undefined;
let mockLocal: Partial<LocalSettingsRecord> | undefined;

jest.mock('../data/queries', () => ({
  readSettingsGeneral: () => Promise.resolve(mockGeneral),
}));
jest.mock('../data/local-settings-store', () => ({
  getLocalSettings: () => Promise.resolve(mockLocal),
}));

// A synchronous stand-in for Dexie's liveQuery: the hook's own contract with it is only
// "undefined until the first answer, then the value", which is what the defaults below
// are written against.
jest.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const react = require('react') as typeof import('react');
    const [value, setValue] = react.useState<unknown>(undefined);
    react.useEffect(() => {
      let live = true;
      void Promise.resolve(querier()).then((next) => void (live && setValue(next)));
      return () => void (live = false);
    }, deps);
    return value;
  },
}));

// A full ThemeState — the coercion under test is about the MODE, but the stored shape is
// the whole record, and a partial one would be coerced away for the wrong reason.
const theme = (mode: ThemeState['mode']): ThemeState => ({ ...DEFAULT_THEME, mode });

beforeEach(() => {
  mockGeneral = undefined;
  mockLocal = undefined;
});

// Let both liveQuery stand-ins answer. Inside act, so their state updates are flushed
// as part of the test rather than landing after it.
const answer = () => act(() => Promise.resolve());

async function settings() {
  const { result, rerender } = renderHook(() => useSettings());
  await answer();
  rerender();
  return result;
}

describe('before anything has been read', () => {
  // The very first render, before either source answers. Consumers must get a concrete
  // layout and theme rather than undefined — this is what runs on every cold load.
  it('gives concrete defaults on the first render', async () => {
    const { result } = renderHook(() => useSettings());

    expect(result.current.linksLayout).toBe('list');
    expect(result.current.linksLayoutSource).toBe('sync');
    expect(result.current.theme).toEqual(DEFAULT_THEME);
    expect(result.current.sortOn).toBe('updatedAt');
    expect(result.current.sortOrder).toBe('desc');
    // The reads are still in flight; let them land inside the test, not after it.
    await answer();
  });

  // Off by DEFAULT: server extraction is the second, explicit opt-in, and an absent value
  // (an older client, or never toggled) must read as opted-OUT. The other direction sends
  // a saved URL to one of our servers for a user who never agreed to it.
  it('reads an absent server-extraction opt-in as off', async () => {
    const { result } = renderHook(() => useSettings());

    expect(result.current.serverExtraction).toBe(false);
    await answer();
  });
});

describe('source resolution', () => {
  it('applies the synced layout when the source is `sync`', async () => {
    mockGeneral = { linksLayout: 'card' };
    mockLocal = { linksLayoutSource: 'sync', linksLayout: 'list' };

    const result = await settings();

    expect(result.current.linksLayout).toBe('card');
    // Both sources stay separately readable — the Settings tabs render each one.
    expect(result.current.syncLinksLayout).toBe('card');
    expect(result.current.localLinksLayout).toBe('list');
  });

  // The opt-out. A device that chose its own layout must keep it even as the synced value
  // changes underneath — that is the entire purpose of the source field.
  it('applies this device’s layout when the source is `local`', async () => {
    mockGeneral = { linksLayout: 'card' };
    mockLocal = { linksLayoutSource: 'local', linksLayout: 'list' };

    const result = await settings();

    expect(result.current.linksLayout).toBe('list');
  });

  it('applies the synced theme when the theme source is `sync`', async () => {
    mockGeneral = { theme: theme('dark') };
    mockLocal = { themeSource: 'sync', theme: theme('light') };

    const result = await settings();

    expect(result.current.theme).toEqual(result.current.syncTheme);
    expect(result.current.theme.mode).toBe('dark');
  });

  it('applies this device’s theme when the theme source is `local`', async () => {
    mockGeneral = { theme: theme('dark') };
    mockLocal = { themeSource: 'local', theme: theme('light') };

    const result = await settings();

    expect(result.current.theme).toEqual(result.current.localTheme);
    expect(result.current.theme.mode).toBe('light');
  });

  // The two sources are independent: a device can follow the synced theme while keeping
  // its own layout. Sharing one source field would collapse that.
  it('resolves layout and theme independently', async () => {
    mockGeneral = { linksLayout: 'card', theme: theme('dark') };
    mockLocal = {
      linksLayoutSource: 'local',
      linksLayout: 'list',
      themeSource: 'sync',
      theme: theme('light'),
    };

    const result = await settings();

    expect(result.current.linksLayout).toBe('list');
    expect(result.current.theme.mode).toBe('dark');
  });

  // Absent source fields (a row written before the feature, or no row at all) default to
  // following the SYNCED value — the shared choice, not this device's leftovers.
  it('defaults both sources to `sync`', async () => {
    mockGeneral = { linksLayout: 'card' };
    mockLocal = {};

    const result = await settings();

    expect(result.current.linksLayoutSource).toBe('sync');
    expect(result.current.themeSource).toBe('sync');
    expect(result.current.linksLayout).toBe('card');
  });
});

describe('forward compatibility', () => {
  // A newer client's layout (`table`, say) must reach consumers as itself. Coercing it to
  // 'list' here would look like a safe normalization and would instead make this device
  // overwrite the newer device's choice on its next settings write.
  it('passes an unknown synced layout through untouched', async () => {
    mockGeneral = { linksLayout: 'table' };

    const result = await settings();

    expect(result.current.linksLayout).toBe('table');
    expect(result.current.syncLinksLayout).toBe('table');
  });

  it('passes an unknown sort through untouched', async () => {
    mockGeneral = { sortOn: 'relevance', sortOrder: 'shuffled' };

    const result = await settings();

    expect(result.current.sortOn).toBe('relevance');
    expect(result.current.sortOrder).toBe('shuffled');
  });

  // The theme is the opposite case, and deliberately so: it is coerced, because an odd
  // persisted value must never drop the whole settings blob and every consumer applies it
  // as a real ThemeState rather than passing it on.
  it('coerces an unusable theme rather than passing it on', async () => {
    mockGeneral = { theme: { ...DEFAULT_THEME, mode: 'neon' } };

    const result = await settings();

    expect(result.current.theme).toEqual(DEFAULT_THEME);
  });
});

describe('identity stability', () => {
  // A fresh object per render churns ThemeProvider's apply effect, and is a latent render
  // loop for any consumer that both deps on `theme` and sets state from it. Only a
  // re-render with unchanged sources can show this.
  it('keeps the theme object identity across renders while its source is unchanged', async () => {
    mockGeneral = { theme: theme('dark') };
    const { result, rerender } = renderHook(() => useSettings());
    await answer();
    rerender();

    const first = result.current.theme;
    rerender();

    expect(result.current.theme).toBe(first);
  });
});

describe('previewsPromptDismissed', () => {
  // Device-local chrome: a second browser that has never shown the banner should still
  // get its one offer, so this can only ever come from the device row.
  it('is false until this device dismisses it', async () => {
    mockLocal = {};
    expect((await settings()).current.previewsPromptDismissed).toBe(false);

    mockLocal = { previewsPromptDismissed: true };
    expect((await settings()).current.previewsPromptDismissed).toBe(true);
  });
});
