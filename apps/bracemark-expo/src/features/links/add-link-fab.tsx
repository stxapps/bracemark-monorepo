// The links screen's add affordance — the FAB the topbar's header comment
// anticipated ("add… likely a FAB here, not a topbar slot"): web puts Add in
// the topbar, which a phone topbar has no room for. Bottom-right over the
// screen body (the RefreshPill overlay idiom), rendered at the SCREEN level —
// not inside Main — so it survives Main's swaps (LockPane for a locked list,
// EmptyState) exactly as web's topbar button stays available there. Hidden in
// bulk-edit mode: the bottom edge belongs to BulkEditBar, and "add a link"
// mid-selection is the wrong affordance.
//
// Pressing it pushes the modal add-link route with the list to pre-select —
// web's useDefaultListId, computed HERE because the route sits outside
// LinksPageProvider: the list the user is viewing (so "add" lands where
// they're looking), falling back to My List — the inbox — for the All view or
// a tag view, neither of which names a single destination list. Trash falls
// back too: it's the deletion staging area, never a place to add new links.

import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';

import { DEFAULT_LIST_ID, TRASH_ID } from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

export function AddLinkFab() {
  const router = useRouter();
  const { selection } = useLinksPage();
  const { bulkEditing } = useLinksViewState();

  if (bulkEditing) return null;

  const listId =
    selection.kind === 'list' && selection.id !== TRASH_ID ? selection.id : DEFAULT_LIST_ID;

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/add-link', params: { listId } })}
      aria-label="Add link"
      className="absolute right-4 bottom-4 z-10 size-14 items-center justify-center rounded-full bg-primary shadow-lg shadow-black/20 active:opacity-90"
    >
      <Icon as={Plus} className="size-6 text-primary-foreground" />
    </Pressable>
  );
}
