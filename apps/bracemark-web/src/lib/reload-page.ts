// A full page reload, behind one seam: `location.reload` is `[LegacyUnforgeable]`,
// so jsdom can neither stub nor observe it, and the update pill's spec needs to
// know WHETHER the page reloads (components/update-pill.spec.tsx).
export function reloadPage(): void {
  window.location.reload();
}
