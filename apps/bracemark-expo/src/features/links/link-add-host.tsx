// Where the add panel (link-add-panel.tsx) is drawn, and who owns whether it is
// open. Mounted by `(app)/links/_layout.tsx` AROUND THE DRAWER — not by the links
// screen inside it — and that placement is the whole point of this file.
//
// The panel is an `absolute inset-0` layer, so its reach is its parent's box.
// Inside the links screen that box is the Drawer's SCREEN, which on a wide window
// is the pane beside the docked rail (features/links/sidebar-rail.tsx): the dim
// stopped at the rail's edge, the rail stayed live beside an open form, and a
// centred panel centred over the list rather than the window. Measured on the
// iPad (A16) simulator, landscape and portrait. Up here the box is the whole
// links section — rail and screen — on every width, and the Drawer is a sibling
// the panel covers, which also takes the narrow window's edge swipe away from
// under it: the Drawer's pan gesture lives on the Drawer's own views.
//
// The state is still only `adding`, and still not view state (the links
// screen's header gives web's reason: it is not an engagement signal). It moved
// with the panel because the FAB that opens it is inside the screen and the
// accessibility hide below has to wrap everything the panel covers; a context
// is the one way the two halves meet. Mounting the panel only while open is
// still what keeps the draft ephemeral (link-add-panel.tsx).

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { View } from 'react-native';

import { LinkAddPanel } from './link-add-panel';

type LinkAdd = {
  adding: boolean;
  openAdd: () => void;
};

const LinkAddContext = createContext<LinkAdd | null>(null);

export function LinkAddHost({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState(false);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const value = useMemo(() => ({ adding, openAdd }), [adding, openAdd]);

  return (
    <LinkAddContext.Provider value={value}>
      <View className="flex-1">
        {/* The covered subtree opts out of the accessibility tree while the
            panel is up — now the rail as well as the screen. iOS is covered
            twice over, this and the panel's `accessibilityViewIsModal`, which
            hides the panel's SIBLINGS — and this wrapper is its sibling.
            Android ignores both props under RN 0.81/Fabric; they stay because
            they are the correct spelling (docs/accessibility.md, _modality_). */}
        <View
          importantForAccessibility={adding ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={adding}
          collapsable={false}
          className="flex-1"
        >
          {children}
        </View>
        {adding && <LinkAddPanel onClose={closeAdd} />}
      </View>
    </LinkAddContext.Provider>
  );
}

export function useLinkAdd(): LinkAdd {
  const value = useContext(LinkAddContext);
  if (!value) throw new Error('useLinkAdd must be used within LinkAddHost');
  return value;
}
