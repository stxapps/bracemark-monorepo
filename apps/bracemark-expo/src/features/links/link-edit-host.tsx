// Who owns the link editor's open state (link-edit-panel.tsx). Mounted by
// `(app)/links/_layout.tsx` beside LinkAddHost, so every row menu in the section
// reaches it through `useLinkEdit()` — hoisted for web's reason (its
// LinkEditDialog is hoisted too): the row that asked for the editor is
// virtualized and can repaint or recycle under it, which must not take the
// draft with it. The editor is a ui/sheet.tsx sheet, drawn here as a sibling
// AFTER the covered Drawer.

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { LinkEditPanel, type LinkEditTarget } from './link-edit-panel';

type LinkEdit = { openEdit: (target: LinkEditTarget) => void };

const LinkEditContext = createContext<LinkEdit | null>(null);

export function LinkEditHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<LinkEditTarget | null>(null);
  const closeEdit = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ openEdit: setTarget }), []);
  return (
    <LinkEditContext.Provider value={value}>
      {children}
      <LinkEditPanel target={target} onClose={closeEdit} />
    </LinkEditContext.Provider>
  );
}

export function useLinkEdit(): LinkEdit {
  const value = useContext(LinkEditContext);
  if (!value) throw new Error('useLinkEdit must be used within LinkEditHost');
  return value;
}
