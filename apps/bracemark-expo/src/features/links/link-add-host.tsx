// Who owns whether the add panel (link-add-panel.tsx) is open. Mounted by
// `(app)/links/_layout.tsx` around the links Drawer, so the FAB inside the
// screen reaches it through `useLinkAdd()`. The panel is a ui/sheet.tsx sheet,
// drawn here as a sibling AFTER the covered Drawer, so it spans the whole links
// section (the layout's SheetHost is the box it covers).
//
// The state is only `adding`, and it is not view state (the links screen's
// header gives web's reason: it is not an engagement signal). Mounting the
// panel only while open is what keeps the draft ephemeral.

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { LinkAddPanel } from './link-add-panel';

type LinkAdd = { openAdd: () => void };

const LinkAddContext = createContext<LinkAdd | null>(null);

export function LinkAddHost({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState(false);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const value = useMemo(() => ({ openAdd }), [openAdd]);

  return (
    <LinkAddContext.Provider value={value}>
      {children}
      {adding && <LinkAddPanel onClose={closeAdd} />}
    </LinkAddContext.Provider>
  );
}

export function useLinkAdd(): LinkAdd {
  const value = useContext(LinkAddContext);
  if (!value) throw new Error('useLinkAdd must be used within LinkAddHost');
  return value;
}
