import { act, fireEvent, render, screen } from '@testing-library/react';

import { DEFAULT_LIST_ID } from '@stxapps/shared';
import type { LinkItem } from '@stxapps/web-react';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import { Editor } from './Editor';

// The popup's save. Three things here are this file's own, and each is a rule about
// what the user meant rather than about wiring:
//
//   - RESTORE MEANS "PUT IT BACK WHERE I JUST SAID". The draft is the request the
//     user made a second ago, so it wins over the old record's fields — but an
//     UNTOUCHED draft must leave the link's own tags and note alone rather than
//     wiping them, and tags UNION, because both sets were wanted. Same rule as
//     bracemark-web's quick-add Restore, so the action means one thing across both
//     apps; there is deliberately no "save a copy anyway" door, since this popup
//     has never been able to save a second copy of the active tab.
//   - THE QUOTA GATE IS THE WALL. In 360px there is no room to render a form that
//     cannot submit, and upgrading is not a flow the extension owns.
//   - THE SAVE KICKS THE CHEAP CAPTURE AND DOES NOT WAIT. `EXTRACT` is
//     fire-and-forget so the complete screen appears at once; the specimen fills in
//     behind it. A restore takes that path too — we are standing on the live page
//     either way, and refreshing the title of a link you are re-adding is the point.

const mockUseLinkMutations = jest.fn();
const mockUseLinkQuota = jest.fn();
const mockSendMessage = jest.fn(async () => ({ ok: true }));

jest.mock('@stxapps/web-react', () => ({
  get useLinkMutations() {
    return mockUseLinkMutations;
  },
  get useLinkQuota() {
    return mockUseLinkQuota;
  },
  linkIdOf: (link: { url: string }) => `id-of:${link.url}`,
}));
jest.mock('@/utils/messages', () => ({
  get sendMessage() {
    return mockSendMessage;
  },
}));

// The two shared pickers come from web-ui and read their options out of the local
// store, which this spec does not have. Stubbed as the plainest controls that can
// still express a pick, so the assertions below are about what the Editor DOES with
// a chosen list and chosen tags.
jest.mock('@stxapps/web-ui/components/links/list-select', () => ({
  ListSelect: (props: { id: string; value: string; onValueChange: (v: string) => void }) => (
    <input
      aria-label="List"
      id={props.id}
      value={props.value}
      onChange={(e) => props.onValueChange(e.target.value)}
    />
  ),
}));
jest.mock('@stxapps/web-ui/components/links/tags-field', () => ({
  TagsField: (props: { id: string; value: string[]; onChange: (v: string[]) => void }) => (
    <input
      aria-label="Tags"
      id={props.id}
      value={props.value.join(',')}
      onChange={(e) => props.onChange(e.target.value === '' ? [] : e.target.value.split(','))}
    />
  ),
}));

const TAB = { url: 'https://example.com/post', title: 'A post' };
const URL_ = 'https://example.com/post';

const TRASHED = {
  url: URL_,
  listId: 'trash',
  tagIds: ['old-tag'],
  note: 'the old note',
} as unknown as LinkItem;

const create = jest.fn();
const update = jest.fn();
const onSaved = jest.fn();

let fake: FakeBrowser;

function renderEditor(trashed?: LinkItem) {
  return render(<Editor tab={TAB} url={URL_} trashed={trashed} onSaved={onSaved} />);
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const press = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  fake = installFakeBrowser();
  create.mockResolvedValue({ url: URL_ });
  update.mockResolvedValue(undefined);
  mockUseLinkMutations.mockReturnValue({ create, update });
  mockUseLinkQuota.mockReturnValue({ count: 3, max: 100, atLimit: false });
});

describe('saving a new page', () => {
  it('writes the link with the draft as the user left it', async () => {
    renderEditor();
    type('List', 'reading');
    type('Tags', 'rust,async');
    type('Note', '  worth a second read  ');

    await press('Save');

    expect(create).toHaveBeenCalledWith({
      url: URL_,
      listId: 'reading',
      tagIds: ['rust', 'async'],
      note: '  worth a second read  ',
    });
  });

  it('defaults to the inbox list, never Trash', async () => {
    renderEditor();

    await press('Save');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ listId: DEFAULT_LIST_ID }));
  });

  it('kicks the cheap capture for the link it just wrote, and does not wait for it', async () => {
    renderEditor();

    await press('Save');

    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'EXTRACT',
      linkId: `id-of:${URL_}`,
      facet: 'titleImage',
    });
    // The heavy facets stay manual on the complete screen.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('hands the created link up so the popup flips without waiting on the live query', async () => {
    renderEditor();

    await press('Save');

    expect(onSaved).toHaveBeenCalledWith({ url: URL_ });
  });

  it('shows progress and refuses a second press while the write is in flight', async () => {
    let release!: () => void;
    create.mockReturnValue(new Promise((resolve) => (release = () => resolve({ url: URL_ }))));
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      release();
    });
  });

  it('re-enables the button when the write is refused, rather than stranding the draft', async () => {
    create.mockResolvedValue(null);
    renderEditor();

    await press('Save');

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('re-enables the button when the write throws', async () => {
    create.mockRejectedValue(new Error('offline'));
    renderEditor();

    await press('Save');

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('restoring a page that is in Trash', () => {
  it('says so, in an alert that announces when it mounts', () => {
    renderEditor(TRASHED);

    expect(screen.getByRole('alert').textContent).toContain('in your Trash');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('restores the existing record instead of minting a copy that would shadow it', async () => {
    renderEditor(TRASHED);
    type('List', 'reading');

    await press('Restore');

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(TRASHED, { listId: 'reading' });
  });

  it('leaves the link’s own tags and note alone when the draft is untouched', async () => {
    renderEditor(TRASHED);

    await press('Restore');

    // Not a wipe: the user typed nothing, so they asked for nothing to change.
    expect(update).toHaveBeenCalledWith(TRASHED, { listId: DEFAULT_LIST_ID });
  });

  it('unions the typed tags with the ones the link already had', async () => {
    renderEditor(TRASHED);
    type('Tags', 'old-tag,new-tag');

    await press('Restore');

    expect(update.mock.calls[0][1].tagIds).toEqual(['old-tag', 'new-tag']);
  });

  it('lets a typed note win over the old one, trimmed', async () => {
    renderEditor(TRASHED);
    type('Note', '  a fresh note  ');

    await press('Restore');

    expect(update.mock.calls[0][1].note).toBe('a fresh note');
  });

  it('reports the restored link with the patch applied, so Complete can flip at once', async () => {
    renderEditor(TRASHED);
    type('List', 'reading');
    type('Tags', 'new-tag');

    await press('Restore');

    expect(onSaved).toHaveBeenCalledWith({
      ...TRASHED,
      listId: 'reading',
      tagIds: ['old-tag', 'new-tag'],
    });
  });

  it('refreshes the extraction too — we are standing on the live page either way', async () => {
    renderEditor(TRASHED);

    await press('Restore');

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EXTRACT', facet: 'titleImage' }),
    );
  });
});

describe('a library at its cap', () => {
  beforeEach(() => {
    mockUseLinkQuota.mockReturnValue({ count: 100, max: 100, atLimit: true });
  });

  it('replaces the whole form — there is no room for one that cannot submit', () => {
    renderEditor();

    expect(screen.getByText('Your library is full')).toBeTruthy();
    expect(screen.queryByLabelText('List')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('hands the upgrade off to the web app, which owns that flow', async () => {
    renderEditor();

    await press(/^Upgrade to/);

    expect(fake.tabs.create).toHaveBeenCalledWith({
      url: 'http://localhost:3000/settings/subscription',
    });
  });

  it('keeps the form for a paid library with no cap to be at', () => {
    // `max: null` is unlimited; `atLimit` alone must not gate the editor.
    mockUseLinkQuota.mockReturnValue({ count: 5000, max: null, atLimit: true });

    renderEditor();

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});
