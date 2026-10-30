import { act, fireEvent, render, screen } from '@testing-library/react';

import type { LinkItem } from '@stxapps/web-react';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import { Complete } from './Complete';

// The screen after a save, and also the screen for a tab that was already saved.
// What is this file's own:
//
//   - THE OVERRIDE-WINS JOIN. Title and image are read from TWO blobs — the user's
//     `custom*` on the link, the machine's values on the extraction — because the
//     writer split keeps a background capture out of the user's file. Reading the
//     extraction first would let a capture appear to overwrite something the user
//     typed.
//   - IT DISPLACES THE PROVISIONAL VALUES. The `titleImage` facet lands a beat
//     after the save, and the tab's favicon is meant to give way to the real
//     preview while the popup is still open. (That the reads are LIVE is Dexie's
//     property, not this file's, and is not asserted here — the stand-in for
//     `useLiveQuery` settles once. What is asserted is the precedence it settles
//     on.)
//   - IT NAMES THE LIST. "Saved" without a destination is half an answer in an app
//     organised around lists, and the user picked one a second ago.

const mockReadLinkByUrl = jest.fn();
const mockReadExtraction = jest.fn();
const mockReadFileBytes = jest.fn();
const mockUseListRows = jest.fn();

jest.mock('@stxapps/web-react', () => ({
  linkIdOf: (link: { url: string }) => `id-of:${link.url}`,
  get readLinkByUrl() {
    return mockReadLinkByUrl;
  },
  get readExtraction() {
    return mockReadExtraction;
  },
  get readFileBytes() {
    return mockReadFileBytes;
  },
  // The real hook: the revoke-on-close case below is a statement about it.
  get useObjectUrl() {
    return jest.requireActual<typeof import('@stxapps/web-react')>('@stxapps/web-react')
      .useObjectUrl;
  },
}));
jest.mock('@stxapps/web-ui/components/links/list-command', () => ({
  get useListRows() {
    return mockUseListRows;
  },
}));
jest.mock('dexie-react-hooks', () => require('../../testing/live-query'));

const LINK = {
  url: 'https://example.com/post',
  listId: 'reading',
} as unknown as LinkItem;

const TAB = { url: 'https://example.com/post', title: 'The tab’s own title' };

let fake: FakeBrowser;

async function show(props: Partial<Parameters<typeof Complete>[0]> = {}) {
  render(<Complete link={LINK} {...props} />);
  await act(async () => undefined);
}

const body = () => document.body.textContent ?? '';

beforeEach(() => {
  jest.clearAllMocks();
  fake = installFakeBrowser();
  mockReadLinkByUrl.mockResolvedValue(LINK);
  mockReadExtraction.mockResolvedValue(undefined);
  mockReadFileBytes.mockResolvedValue(undefined);
  mockUseListRows.mockReturnValue([{ item: { id: 'reading', name: 'Reading' } }]);
  Object.assign(URL, {
    createObjectURL: jest.fn(() => 'blob:preview'),
    revokeObjectURL: jest.fn(),
  });
});

describe('what it says', () => {
  it('confirms the save in words, not only in the specimen’s cut corner', async () => {
    await show();

    expect(screen.getByRole('heading').textContent).toBe('Saved');
  });

  it('names the list the link landed in', async () => {
    await show();

    expect(body()).toContain('Reading');
  });

  it('leaves the row out rather than flashing a placeholder before the tree loads', async () => {
    mockUseListRows.mockReturnValue([]);

    await show();

    expect(body()).not.toContain('In ');
  });

  it('re-reads the list tree, so a list renamed on another device reads correctly', async () => {
    mockUseListRows.mockReturnValue([{ item: { id: 'reading', name: 'Renamed elsewhere' } }]);

    await show();

    expect(body()).toContain('Renamed elsewhere');
  });
});

describe('the title', () => {
  it('prefers what the user typed over what the capture found', async () => {
    mockReadLinkByUrl.mockResolvedValue({ ...LINK, customTitle: 'What the user typed' });
    mockReadExtraction.mockResolvedValue({ title: 'What the capture found' });

    await show({ tab: TAB });

    expect(body()).toContain('What the user typed');
    expect(body()).not.toContain('What the capture found');
  });

  it('takes the extracted title once the background capture lands', async () => {
    mockReadExtraction.mockResolvedValue({ title: 'What the capture found' });

    await show({ tab: TAB });

    expect(body()).toContain('What the capture found');
  });

  it('falls back to the live tab’s title while nothing has been extracted yet', async () => {
    await show({ tab: TAB });

    expect(body()).toContain('The tab’s own title');
  });
});

describe('the preview image', () => {
  it('reads the bytes the capture stored and shows them', async () => {
    mockReadExtraction.mockResolvedValue({ imageId: 'file-1' });
    mockReadFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await show({ tab: TAB });

    expect(mockReadFileBytes).toHaveBeenCalledWith('file-1');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
  });

  it('prefers the user’s own image over the extracted one', async () => {
    mockReadLinkByUrl.mockResolvedValue({ ...LINK, customImageId: 'user-file' });
    mockReadExtraction.mockResolvedValue({ imageId: 'extracted-file' });
    mockReadFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await show({ tab: TAB });

    expect(mockReadFileBytes).toHaveBeenCalledWith('user-file');
  });

  it('reads no file at all when neither blob names one', async () => {
    await show({ tab: TAB });

    expect(mockReadFileBytes).not.toHaveBeenCalled();
  });

  it('revokes the object URL when the popup closes', async () => {
    // A popup that leaked one per open would hold the decrypted bytes of every
    // page the user saved that session.
    mockReadExtraction.mockResolvedValue({ imageId: 'file-1' });
    mockReadFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { unmount } = render(<Complete link={LINK} tab={TAB} />);
    await act(async () => undefined);

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});

describe('the way out', () => {
  it('opens the library in a tab — the popup cannot navigate itself there', async () => {
    await show();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Open Bracemark/ }));
    });

    expect(fake.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000/links' });
  });

  it("opens it in the page's Firefox container, where the web session is", async () => {
    // The rules are utils/open-web-app.spec.ts's; this pins that the button uses it.
    fake.tabs.query.mockResolvedValue([{ id: 1, cookieStoreId: 'firefox-container-3' }]);
    await show();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Open Bracemark/ }));
    });

    expect(fake.tabs.create).toHaveBeenCalledWith({
      url: 'http://localhost:3000/links',
      cookieStoreId: 'firefox-container-3',
    });
  });
});
