// Specs for share-theme-store: where each platform's mirror file lands, and —
// the part that actually matters — that every unreadable shape degrades to
// `system`, which is the OS-following behaviour this mirror replaces. A theme
// mirror that threw, or that returned a half-parsed state, would take down the
// share sheet's FIRST RENDER (share-root.tsx applies it during render), so the
// failure paths are the point of this file.
//
// expo-file-system gets the same in-memory stand-in share-store.spec.ts uses,
// trimmed to what this module touches: exists / textSync / write / create.
import { Platform } from 'react-native';

import { DEFAULT_THEME, type ThemeState } from '@stxapps/shared';

import { readShareTheme, writeShareTheme } from './share-theme-store';

const mockFiles = new Map<string, string>();

jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]): string =>
    parts
      .map((part) => (typeof part === 'string' ? part : (part as { uri: string }).uri))
      .join('/')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '');

  class MockFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists(): boolean {
      return mockFiles.has(this.uri);
    }
    textSync(): string {
      const text = mockFiles.get(this.uri);
      if (text === undefined) throw new Error(`MockFile: no such file ${this.uri}`);
      return text;
    }
    write(text: string): void {
      mockFiles.set(this.uri, text);
    }
    create(): void {
      mockFiles.set(this.uri, '');
    }
  }

  class MockDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
  }

  // Scheme-less, like the App Group root below: the join above collapses
  // repeated slashes, so a `file:///` prefix would not survive it.
  return {
    Paths: { document: 'documents', cache: 'cache', appleSharedContainers: {} },
    File: MockFile,
    Directory: MockDirectory,
  };
});

jest.mock('./app-group', () => ({
  appGroupDir: () => {
    const { Directory } = jest.requireMock<typeof import('expo-file-system')>('expo-file-system');
    return new Directory('group');
  },
}));

// Platform.OS is a plain writable field on RN's Platform object (share-store.spec.ts).
const platform = Platform as { OS: string };
const originalOS = platform.OS;

const IOS_FILE = 'group/share/theme.json';
const ANDROID_FILE = 'documents/share/theme.json';

// The writer skips a write identical to this process's last one, and that state
// is module-level — so every test that WRITES uses a distinct preference.
function pref(patch: Partial<ThemeState>): ThemeState {
  return { ...DEFAULT_THEME, ...patch };
}

beforeEach(() => {
  mockFiles.clear();
});
afterEach(() => {
  platform.OS = originalOS;
});

describe('writeShareTheme', () => {
  it('writes into the App Group container on iOS', () => {
    platform.OS = 'ios';
    const state = pref({ mode: 'dark' });
    writeShareTheme(state);
    expect(mockFiles.get(IOS_FILE)).toBe(JSON.stringify(state));
  });

  it('writes into the document directory on Android', () => {
    platform.OS = 'android';
    const state = pref({ mode: 'custom', darkStart: '21:15' });
    writeShareTheme(state);
    expect(mockFiles.get(ANDROID_FILE)).toBe(JSON.stringify(state));
  });

  // The provider's effect can re-run carrying the same preference; the mirror
  // is a file, so don't touch the disk for it.
  it('skips a write identical to this process’s last one', () => {
    platform.OS = 'android';
    const state = pref({ mode: 'custom', darkStart: '20:05' });
    writeShareTheme(state);
    mockFiles.clear();
    writeShareTheme(state);
    expect(mockFiles.has(ANDROID_FILE)).toBe(false);
  });
});

describe('readShareTheme', () => {
  it('round-trips a written preference', () => {
    platform.OS = 'android';
    const state = pref({ mode: 'custom', lightStart: '07:30', darkStart: '22:45' });
    writeShareTheme(state);
    expect(readShareTheme()).toEqual(state);
  });

  // Every one of these is a real path: never written (fresh install), swept by
  // the sign-out teardown, a truncated write, or a shape from another build.
  it('falls back to system when the file is missing', () => {
    platform.OS = 'android';
    expect(readShareTheme()).toEqual(DEFAULT_THEME);
    expect(readShareTheme().mode).toBe('system');
  });

  it('falls back to system on unparseable JSON', () => {
    platform.OS = 'android';
    mockFiles.set(ANDROID_FILE, '{"mode":');
    expect(readShareTheme()).toEqual(DEFAULT_THEME);
  });

  it('coerces an unknown mode and malformed times rather than trusting them', () => {
    platform.OS = 'android';
    mockFiles.set(ANDROID_FILE, JSON.stringify({ mode: 'sepia', lightStart: '25:99' }));
    expect(readShareTheme()).toEqual(DEFAULT_THEME);
  });

  it('reads the App Group copy on iOS, not the document one', () => {
    platform.OS = 'ios';
    const state = pref({ mode: 'light' });
    mockFiles.set(ANDROID_FILE, JSON.stringify(state));
    expect(readShareTheme()).toEqual(DEFAULT_THEME);
    mockFiles.set(IOS_FILE, JSON.stringify(state));
    expect(readShareTheme()).toEqual(state);
  });
});
