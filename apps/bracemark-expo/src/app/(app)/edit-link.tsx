import { LinkEditScreen } from '../../features/links/link-edit-screen';

// `/edit-link` — the full link editor, presented as a modal over the app Stack
// (declared in this group's _layout, beside `/add-link`; the screen's header
// carries the pushed-screen-vs-hoisted-dialog rationale). The target link and
// the optional landing field ride in as params (`linkId`, `focus`) — the row
// menu computes them (link-row-menu.tsx). Thin by convention — the UI is in
// src/features/links/.
export default function EditLinkRoute() {
  return <LinkEditScreen />;
}
