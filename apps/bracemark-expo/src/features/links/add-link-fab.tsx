// The links screen's add affordance — the FAB the topbar's header comment
// anticipated ("add… likely a FAB here, not a topbar slot"): web puts Add in
// the topbar, which a phone topbar has no room for. Bottom-right over the
// screen body (the RefreshPill overlay idiom), rendered at the SCREEN level —
// not inside Main — so it survives Main's swaps (LockPane for a locked list,
// EmptyState) exactly as web's topbar button stays available there. Hidden in
// bulk-edit mode: the bottom edge belongs to BulkEditBar, and "add a link"
// mid-selection is the wrong affordance.
//
// Pressing it asks the screen to open the add panel, and that is the whole job
// now — the panel is a layer over this screen rather than a pushed route
// (link-add-panel.tsx carries the three measured reasons), so there is no
// navigation here and no list to pre-compute: the panel reads the viewing list
// straight from LinksPageProvider, which it now sits inside.
import { Pressable } from 'react-native';
import { Plus } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { useLinksViewState } from './view-state-provider';

export function AddLinkFab({ onPress }: { onPress: () => void }) {
  const { bulkEditing } = useLinksViewState();

  if (bulkEditing) return null;

  return (
    <Pressable
      role="button"
      onPress={onPress}
      aria-label="Add link"
      className="absolute right-4 bottom-4 z-10 size-14 items-center justify-center rounded-full bg-primary shadow-lg shadow-black/20 active:opacity-90"
    >
      <Icon as={Plus} className="size-6 text-primary-foreground" />
    </Pressable>
  );
}
