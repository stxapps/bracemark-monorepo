import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ThemeState } from '@stxapps/shared';

import { ThemeSection } from './ThemeSection';

// The one synced setting that applies to the extension. The theme ARITHMETIC is
// shared's and the resolution is `use-settings.ts`'s; what this file owns is the
// sync/device split and one accessibility rule:
//
//   - EACH TAB IS BOUND TO ITS OWN SOURCE. The active tab IS the active source, so
//     the controls on screen always describe the theme the extension is actually
//     rendering. Wire a tab to the wrong state and the page shows a setting the user
//     is not looking at, with nothing to signal it.
//   - A FAILED WRITE HAS TO ANNOUNCE. The mutation is async and the controls stay
//     live for a retry, so without `role="alert"` the only feedback is a line of
//     red text a screen-reader user never hears (docs/accessibility.md — an error
//     message that MOUNTS must carry it).
//   - THE CROSSOVER TIMES BELONG TO `custom` AND APPEAR ONLY THERE.

const mockUseSettings = jest.fn();
const mockUseSettingMutations = jest.fn();

jest.mock('@stxapps/web-react', () => ({
  get useSettings() {
    return mockUseSettings;
  },
  get useSettingMutations() {
    return mockUseSettingMutations;
  },
}));

const SYNCED: ThemeState = { mode: 'system', lightStart: '06:00', darkStart: '18:00' };
const DEVICE: ThemeState = { mode: 'dark', lightStart: '07:30', darkStart: '20:30' };

const setThemeSource = jest.fn(async () => undefined);
const setSyncTheme = jest.fn(async () => undefined);
const setLocalTheme = jest.fn(async () => undefined);

function setSettings(overrides: Record<string, unknown> = {}): void {
  mockUseSettings.mockReturnValue({
    themeSource: 'sync',
    syncTheme: SYNCED,
    localTheme: DEVICE,
    ...overrides,
  });
}

// The radio inside the row whose label STARTS with `name`. Anchored because each
// row's accessible name is its label plus its hint, and "Custom time"'s hint reads
// "Light by day, dark by night".
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  jest.clearAllMocks();
  // Implementations too, not just the call records: a `mockRejectedValue` left
  // standing from an earlier case would make the "and then it succeeds" cases lie.
  setThemeSource.mockResolvedValue(undefined);
  setSyncTheme.mockResolvedValue(undefined);
  setLocalTheme.mockResolvedValue(undefined);
  setSettings();
  mockUseSettingMutations.mockReturnValue({ setThemeSource, setSyncTheme, setLocalTheme });
});

describe('the sync/device split', () => {
  it('shows the SYNCED theme’s mode while the Sync tab is the source', () => {
    render(<ThemeSection />);

    expect(radio('System').getAttribute('data-state')).toBe('checked');
    expect(radio('Dark').getAttribute('data-state')).toBe('unchecked');
  });

  it('shows the DEVICE theme’s mode while the Device tab is the source', () => {
    setSettings({ themeSource: 'local' });

    render(<ThemeSection />);

    expect(radio('Dark').getAttribute('data-state')).toBe('checked');
  });

  it('writes a mode picked on the Sync tab to the synced setting', () => {
    render(<ThemeSection />);

    fireEvent.click(radio('Light'));

    // The whole ThemeState, not just the mode — the crossover times ride along.
    expect(setSyncTheme).toHaveBeenCalledWith({ ...SYNCED, mode: 'light' });
    expect(setLocalTheme).not.toHaveBeenCalled();
  });

  it('writes a mode picked on the Device tab to this browser’s setting only', () => {
    setSettings({ themeSource: 'local' });

    render(<ThemeSection />);
    fireEvent.click(radio('Light'));

    expect(setLocalTheme).toHaveBeenCalledWith({ ...DEVICE, mode: 'light' });
    expect(setSyncTheme).not.toHaveBeenCalled();
  });

  it('moves the source itself when the tab changes', () => {
    render(<ThemeSection />);

    // Radix picks a tab on mousedown, not on click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Device' }));

    // "Device" is what the `'local'` source is called for users.
    expect(setThemeSource).toHaveBeenCalledWith('local');
  });
});

describe('the crossover times', () => {
  it('are hidden until the mode is Custom time', () => {
    render(<ThemeSection />);

    expect(screen.queryByLabelText('Light starts')).toBeNull();
  });

  it('show the source’s own times in Custom time', () => {
    setSettings({ syncTheme: { ...SYNCED, mode: 'custom' } });

    render(<ThemeSection />);

    expect(screen.getByLabelText<HTMLInputElement>('Light starts').value).toBe('06:00');
    expect(screen.getByLabelText<HTMLInputElement>('Dark starts').value).toBe('18:00');
  });

  it('write the edited time back with the rest of the state intact', () => {
    setSettings({ syncTheme: { ...SYNCED, mode: 'custom' } });

    render(<ThemeSection />);
    fireEvent.change(screen.getByLabelText('Dark starts'), { target: { value: '21:15' } });

    expect(setSyncTheme).toHaveBeenCalledWith({ ...SYNCED, mode: 'custom', darkStart: '21:15' });
  });
});

describe('when a write fails', () => {
  it('announces the failure rather than swallowing it', async () => {
    setSyncTheme.mockRejectedValueOnce(new Error('No active account'));

    render(<ThemeSection />);
    await act(async () => {
      fireEvent.click(radio('Light'));
    });

    // role="alert": the mutation is async, so nothing else tells a screen-reader
    // user the pick did not take.
    expect(screen.getByRole('alert').textContent).toContain('No active account');
  });

  it('leaves the controls live for a retry', async () => {
    setSyncTheme.mockRejectedValueOnce(new Error('No active account'));

    render(<ThemeSection />);
    await act(async () => {
      fireEvent.click(radio('Light'));
    });
    await act(async () => {
      fireEvent.click(radio('Dark'));
    });

    expect(setSyncTheme).toHaveBeenCalledTimes(2);
  });

  it('clears the previous failure when a later write succeeds', async () => {
    setSyncTheme.mockRejectedValueOnce(new Error('No active account'));

    render(<ThemeSection />);
    await act(async () => {
      fireEvent.click(radio('Light'));
    });
    await act(async () => {
      fireEvent.click(radio('Dark'));
    });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing at all while everything is working', () => {
    render(<ThemeSection />);

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
