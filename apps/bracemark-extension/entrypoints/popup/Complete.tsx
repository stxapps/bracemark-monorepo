import { useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, Folder } from 'lucide-react';

import {
  linkIdOf,
  type LinkItem,
  readExtraction,
  readFileBytes,
  readLinkByUrl,
} from '@stxapps/web-react';
import { useListRows } from '@stxapps/web-ui/components/links/list-command';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { type ActiveTab } from './App';
import { PageSpecimen } from './PageSpecimen';
import { PopupBody, PopupTitle } from './Shell';

import { WEB_APP_URL } from '@/utils/web-app-url';

// The complete screen — shown right after a save AND when the active tab is already
// saved (the revisit / bonus path). It is the same PageSpecimen the editor showed,
// with its corner now cut: the page has been marked, which is the brand's own
// gesture and the whole "saved" signal (see PageSpecimen). The form beneath it is
// replaced by the one thing left to do, opening the library.
//
// The specimen stays reactive. The titleImage facet fills `title`/`imageId` into
// the link's `extractions/{id}.enc` in the background a beat after the save, and
// the live reads here pick it up — so the tile's favicon is quietly upgraded to
// the page's real preview image while the popup is still open.
//
// It also names the LIST the link landed in, which the previous version of this
// screen left out. "Saved" without a destination is only half an answer in an app
// whose whole organising idea is lists, and the user picked one a second ago —
// echoing it back is what confirms the pick took.
//
// The footer button reads "Open Bracemark" (navigation), not "view this link": the
// extension's session doesn't cross origins (docs/browser-extension.md), so a user
// who never signed in to bracemark-web lands on its sign-in page first.
export function Complete({ link, tab }: { link: LinkItem; tab?: ActiveTab }) {
  const id = linkIdOf(link);
  // Re-read the link + extraction live so background backfills/captures show up. The
  // display title/image are the override-wins join of the two (the user's `custom*` on
  // the link, the extracted values on the extraction — the writer-split).
  const liveLink = useLiveQuery(() => readLinkByUrl(link.url), [link.url]) ?? link;
  const extraction = useLiveQuery(() => readExtraction(id), [id]);

  const title = liveLink.customTitle ?? extraction?.title;
  const imageId = liveLink.customImageId ?? extraction?.imageId;
  const imageBytes = useLiveQuery(
    () => (imageId ? readFileBytes(imageId) : Promise.resolve(undefined)),
    [imageId],
  );
  const imageUrl = useMemo(
    () => (imageBytes ? URL.createObjectURL(new Blob([imageBytes as BlobPart])) : undefined),
    [imageBytes],
  );
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  // The list's own name, from the same live tree ListSelect just picked from — so
  // a list renamed on another device reads correctly here too. Undefined only in
  // the gap before the tree loads, which is why the row below is conditional
  // rather than showing a placeholder that flickers into a real name.
  const listName = useListRows().find((row) => row.item.id === liveLink.listId)?.item.name;

  return (
    <PopupBody>
      <div className={cn('flex flex-col gap-3')}>
        <PopupTitle>Saved</PopupTitle>
        {/* `tab` is absent on the revisit path (App renders Complete straight from
            a live-query match, with no editor in between) — the extracted image
            usually covers that case, and HostMonogram covers the rest. */}
        <PageSpecimen
          title={title || tab?.title}
          url={liveLink.url}
          imageUrl={imageUrl}
          iconUrl={tab?.iconUrl}
          saved
        />
      </div>

      {listName && (
        <p className={cn('flex items-center gap-2 text-xs text-muted-foreground')}>
          <Folder className={cn('size-3.5 shrink-0')} aria-hidden="true" />
          <span className={cn('truncate')}>
            In <span className={cn('font-medium text-foreground')}>{listName}</span>
          </span>
        </p>
      )}

      <Button
        variant="outline"
        onClick={() => {
          void browser.tabs.create({ url: `${WEB_APP_URL}/links` });
        }}
      >
        Open Bracemark
        <ArrowUpRight data-icon="inline-end" className={cn('size-4')} />
      </Button>
    </PopupBody>
  );
}
