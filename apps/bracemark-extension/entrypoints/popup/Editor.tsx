import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';

import { DEFAULT_LIST_ID, LINK_NOTE_MAX, PLAN_LABELS, TRASH_ID } from '@stxapps/shared';
import { linkIdOf, type LinkItem, useLinkMutations, useLinkQuota } from '@stxapps/web-react';
import { LinkQuotaBanner } from '@stxapps/web-ui/components/links/link-quota-banner';
import { ListSelect } from '@stxapps/web-ui/components/links/list-select';
import { TagsField } from '@stxapps/web-ui/components/links/tags-field';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Textarea } from '@stxapps/web-ui/components/ui/textarea';
import { cn } from '@stxapps/web-ui/lib/utils';

import { type ActiveTab } from './App';
import { PageSpecimen } from './PageSpecimen';
import { PopupBody, PopupTitle } from './Shell';

import { sendMessage } from '@/utils/messages';
import { WEB_APP_URL } from '@/utils/web-app-url';

// Signed-in, not-yet-saved: a popup-sized link editor for the active tab. The
// page itself is the PageSpecimen at the top — the same object the complete
// screen shows, so the save happens in place rather than swapping one screen for
// another. Below it the shared ListSelect / TagsField pickers (web-ui — the same
// pieces bracemark-web's quick-add popover and edit dialog render) and an optional
// note. Save writes one `links/{id}.enc`, kicks the cheap active-tab extraction
// (titleImage + readMode, fire-and-forget), and hands the created link up so the
// popup shows the complete page.
//
// There is no URL FIELD, and that's the difference between this editor and
// bracemark-web's quick-add: the URL isn't something the user types here, it's the
// tab they're standing on. So it's presented as the subject of the screen, not as
// a disabled input pretending to be editable.
//
// A free library at its link cap replaces the whole editor with the shared
// LinkQuotaBanner (useLinkQuota) — in ~360px of popup there's no room to render a
// form that can't submit, and this gate IS the cap (the server stopped counting
// links; see the hook), so the banner is the wall itself. Upgrading isn't a
// flow the extension owns, so the CTA opens the web app's subscription settings in
// a tab, the same hand-off SignIn makes for account creation.
//
// `trashed` — this tab's URL is already saved, but in Trash (App's SaveFlow, which
// routes every other already-saved match to Complete). The form is unchanged; only
// the write differs: it RESTORES that record rather than minting a copy that would
// shadow it. There's deliberately no "save a copy anyway" door here, unlike
// bracemark-web's quick-add: this popup has never been able to save a second copy of
// the active tab (an already-saved tab goes to Complete), so adding one for the
// trashed case would be a new power in the smaller surface.
export function Editor({
  tab,
  url,
  trashed,
  onSaved,
}: {
  tab: ActiveTab;
  url: string;
  trashed?: LinkItem;
  onSaved: (link: LinkItem) => void;
}) {
  const linkMutations = useLinkMutations();
  const { count, max, atLimit } = useLinkQuota();

  const [listId, setListId] = useState<string>(DEFAULT_LIST_ID);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Restore the trashed match: it lands in the list the form names (never Trash —
  // ListSelect excludes it), carrying whatever else was typed. The draft is the
  // request the user just made, so it wins over the old record's fields; an
  // untouched draft leaves the link's own tags/note alone rather than wiping them,
  // and tags UNION because both sets were wanted. Same rule as bracemark-web's
  // quick-add Restore, so the action means one thing across both apps. The returned
  // snapshot is the patch applied locally — enough for Complete to flip at once,
  // which re-reads the link live anyway.
  async function restore(link: LinkItem): Promise<LinkItem> {
    const trimmedNote = note.trim();
    const tags = tagIds.length > 0 ? [...new Set([...link.tagIds, ...tagIds])] : link.tagIds;
    const patch = {
      listId,
      ...(tagIds.length > 0 ? { tagIds: tags } : {}),
      ...(trimmedNote ? { note: trimmedNote } : {}),
    };
    await linkMutations.update(link, patch);
    return { ...link, ...patch, tagIds: tags };
  }

  async function save() {
    setSaving(true);
    try {
      const link = trashed
        ? await restore(trashed)
        : await linkMutations.create({ url, listId, tagIds, note });
      if (!link) {
        setSaving(false);
        return;
      }
      // Auto-run the cheap facets off the live DOM, fire-and-forget (heavy screenshot
      // / page copy stay manual on the complete page — see link-extraction.md). A
      // restore takes this path too: we're standing on the live page either way, and
      // refreshing the title/image of a link you're re-adding is the point.
      const id = linkIdOf(link);
      void sendMessage({ type: 'EXTRACT', linkId: id, facet: 'titleImage' });

      onSaved(link);
    } catch {
      setSaving(false);
    }
  }

  if (atLimit && max !== null) {
    return (
      <PopupBody>
        <PopupTitle>Your library is full</PopupTitle>
        <LinkQuotaBanner
          count={count}
          max={max}
          action={
            <Button
              size="sm"
              className={cn('self-end')}
              onClick={() => {
                void browser.tabs.create({ url: `${WEB_APP_URL}/settings/subscription` });
              }}
            >
              Upgrade to {PLAN_LABELS.plus}
            </Button>
          }
        />
      </PopupBody>
    );
  }

  return (
    <PopupBody>
      <div className={cn('flex flex-col gap-3')}>
        <PopupTitle>{trashed ? 'Restore this page' : 'Save this page'}</PopupTitle>
        <PageSpecimen title={tab.title} url={url} iconUrl={tab.iconUrl} />
      </div>

      {trashed && (
        <p
          role="alert"
          className={cn(
            'flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400',
          )}
        >
          <TriangleAlert className={cn('mt-0.5 size-3.5 shrink-0')} aria-hidden="true" />
          <span>
            This page is in your Trash. Restoring puts it back in the list you pick below.
          </span>
        </p>
      )}

      <div className={cn('flex flex-col gap-3.5')}>
        <div className={cn('flex flex-col gap-1.5')}>
          <Label htmlFor="list">List</Label>
          {/* No Trash target: a fresh save never lands in the deletion staging area.
              allowCreate matters most here: the popup can't link out to the web app's
              list settings without killing itself and the draft with it. */}
          <ListSelect
            id="list"
            value={listId}
            onValueChange={setListId}
            excludeIds={[TRASH_ID]}
            allowCreate
          />
        </div>

        <div className={cn('flex flex-col gap-1.5')}>
          <Label htmlFor="tag">Tags</Label>
          <TagsField id="tag" value={tagIds} onChange={setTagIds} />
        </div>

        <div className={cn('flex flex-col gap-1.5')}>
          <Label htmlFor="note">Note</Label>
          {/* resize-none: the drag handle is a trap in a window the browser sizes to
              its content — pulling it down grows the popup past what fits. */}
          <Textarea
            id="note"
            maxLength={LINK_NOTE_MAX}
            value={note}
            placeholder="Optional note"
            className={cn('min-h-16 resize-none')}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      <Button onClick={save} disabled={saving}>
        {trashed ? (saving ? 'Restoring…' : 'Restore') : saving ? 'Saving…' : 'Save'}
      </Button>
    </PopupBody>
  );
}
