// Who owns the WIDE link editor's open state (link-edit-screen.tsx's
// LinkEditDialog). Mounted by `(app)/links/_layout.tsx` beside LinkAddHost, so
// every row menu in the section reaches it through `useLinkEdit()` — hoisted
// for web's reason (its LinkEditDialog is hoisted too): the row that asked for
// the editor is virtualized and can repaint or recycle under it, which must not
// take the draft with it. The Dialog portals to APP_PORTAL_HOST, so where this
// sits decides only who can open it, not what it covers.
//
// The narrow editor needs none of this: it is the `/edit-link` route, and the
// row menu pushes it (link-row-menu.tsx picks by width).

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { LinkEditDialog, type LinkEditTarget } from './link-edit-screen';

type LinkEdit = { openEdit: (target: LinkEditTarget) => void };

const LinkEditContext = createContext<LinkEdit | null>(null);

export function LinkEditHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<LinkEditTarget | null>(null);
  const closeEdit = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ openEdit: setTarget }), []);
  return (
    <LinkEditContext.Provider value={value}>
      {children}
      <LinkEditDialog target={target} onClose={closeEdit} />
    </LinkEditContext.Provider>
  );
}

export function useLinkEdit(): LinkEdit {
  const value = useContext(LinkEditContext);
  if (!value) throw new Error('useLinkEdit must be used within LinkEditHost');
  return value;
}
