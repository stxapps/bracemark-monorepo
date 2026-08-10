import { LinkAddScreen } from '../../features/links/link-add-screen';

// `/add-link` — the quick-add editor, presented as a modal over the app Stack
// (declared in this group's _layout; the screen's header carries the
// router-screen-vs-RN-Modal rationale). A Stack sibling of `links/` rather
// than a route inside it: the links group is a Drawer, which can't present a
// screen modally — so the pre-selected list rides in as a `listId` param
// (add-link-fab.tsx) instead of reading LinksPageProvider. Thin by convention
// — the UI is in src/features/links/.
export default function AddLinkRoute() {
  return <LinkAddScreen />;
}
