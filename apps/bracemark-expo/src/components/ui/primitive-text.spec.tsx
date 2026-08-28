import * as React from 'react';
import { render } from '@testing-library/react-native';

import { AlertDialogDescription, AlertDialogTitle } from './alert-dialog';
import { DialogDescription, DialogTitle } from './dialog';
import { DropdownMenuLabel } from './dropdown-menu';

// The one check that reaches INTO node_modules. @rn-primitives' `Title`,
// `Description` and `Label` render react-native's own `Text` unless the wrapper
// stops them, and that render is invisible to every other guard we have: no lint
// rule (expo's `no-restricted-imports` block only guards the share bundle), no
// type error, and a repo-wide grep for `<Text` comes back clean because the
// offending JSX is in a package. The symptom is a dialog title in the system
// face, uncapped past the app-wide 1.3 multiplier while its chrome stays dp —
// which looks close enough to right that it shipped across 12 call sites once.
//
// So assert the shape rather than the spelling: exactly ONE Text node, carrying
// what `ui/text.tsx` adds. A second, bare Text — nested or in place of ours — is
// the whole failure class, whichever way a future primitive reintroduces it.
// `ui/dialog.tsx` is the reason this file is not just a comment: its primitive's
// native build ignores `asChild`, so the fix that works for the other two
// silently produced a bare Text WRAPPING ours (docs/accessibility.md, _font
// scaling is an accessibility policy_).
type Node = { type: string; props: Record<string, unknown>; children?: unknown[] };

function textNodes(ui: React.ReactElement): Node[] {
  const found: Node[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Node;
    if (n.type === 'Text') found.push(n);
    n.children?.forEach(walk);
  };
  walk(render(ui).toJSON());
  return found;
}

test.each([
  ['DialogTitle', <DialogTitle key="a">Title</DialogTitle>, 'heading'],
  ['DialogDescription', <DialogDescription key="b">Description</DialogDescription>, undefined],
  ['AlertDialogTitle', <AlertDialogTitle key="c">Title</AlertDialogTitle>, 'heading'],
  [
    'AlertDialogDescription',
    <AlertDialogDescription key="d">Description</AlertDialogDescription>,
    undefined,
  ],
  ['DropdownMenuLabel', <DropdownMenuLabel key="e">Label</DropdownMenuLabel>, undefined],
])('%s renders one capped Inter Text, not the primitive’s bare one', (_name, ui, role) => {
  const nodes = textNodes(ui);
  expect(nodes).toHaveLength(1);
  expect(String(nodes[0].props.className)).toContain('font-sans');
  expect(nodes[0].props.maxFontSizeMultiplier).toBe(1.3);
  // The heading role has to land on OUR Text, where ui/text.tsx's role map and
  // the screen reader can both see it — not on a wrapper around it.
  expect(nodes[0].props.role).toBe(role);
});
