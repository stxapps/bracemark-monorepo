// A full page reload, behind one seam: `location.reload` is `[LegacyUnforgeable]`,
// so jsdom can neither stub nor observe it, and the update pill's and the
// update-required banner's specs need to know WHETHER — and WHEN — the page reloads
// (components/update-pill.spec.tsx, components/update-required-banner.spec.tsx).
export function reloadPage(): void {
  window.location.reload();
}
