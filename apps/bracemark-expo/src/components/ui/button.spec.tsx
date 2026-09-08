import * as React from 'react';
import { render } from '@testing-library/react-native';
import { Upload } from 'lucide-react-native';

import { Button } from './button';
import { DropdownMenu, DropdownMenuTrigger } from './dropdown-menu';
import { Icon } from './icon';
import { Text } from './text';

// The icons here carry no `className`, unlike every call site in the app. That
// prop reaches components through uniwind's augmentation in uniwind-env.d.ts,
// which tsconfig.spec.json doesn't include (tsconfig.json and the app config
// do) — so `<Icon className="size-4" />` compiles in the app and fails in a
// spec. Nothing is lost: the rule under test reads the child's TYPE, never its
// classes.
//
// The icon-edge padding (see button.tsx's header): the edge an icon sits
// against gets the smaller padding, and the flags come from the children, not
// from the call site. Asserting on the className the Pressable receives —
// uniwind resolves it to styles at runtime, but what this rule decides IS the
// class, and that keeps the test free of a native style snapshot.
function classNameOf(ui: React.ReactElement): string {
  const { UNSAFE_root } = render(ui);
  return String(UNSAFE_root.findByProps({ role: 'button' }).props.className ?? '');
}

test('a leading icon trims the leading padding only', () => {
  const cls = classNameOf(
    <Button>
      <Icon as={Upload} />
      <Text>Choose a file</Text>
    </Button>,
  );
  expect(cls).toContain('pl-3');
  expect(cls).not.toContain('pr-3');
});

test('a trailing icon trims the trailing padding only', () => {
  const cls = classNameOf(
    <Button>
      <Text>Continue</Text>
      <Icon as={Upload} />
    </Button>,
  );
  expect(cls).toContain('pr-3');
  expect(cls).not.toContain('pl-3');
});

test('the trim follows the size', () => {
  const cls = classNameOf(
    <Button size="sm">
      <Icon as={Upload} />
      <Text>Sort</Text>
    </Button>,
  );
  expect(cls).toContain('pl-2.5');
});

// The two cases a marker prop would get wrong, and the reason the flags are
// derived: an icon with no label to balance against, and an icon that isn't
// rendered on this pass.
test('an icon-only button stays symmetric', () => {
  const cls = classNameOf(
    <Button size="sm">
      <Icon as={Upload} />
    </Button>,
  );
  expect(cls).not.toContain('pl-2.5');
});

test('a conditional icon takes its padding with it', () => {
  const busy = false;
  const cls = classNameOf(
    <Button>
      {busy && <Icon as={Upload} />}
      <Text>Save</Text>
    </Button>,
  );
  expect(cls).not.toContain('pl-3');
});

// THE TRIGGER COMPOSITION. Every ⋯ menu in the app is
// `<DropdownMenuTrigger asChild><Button …>`, which is how web spells it too. The
// primitive clones its child with its own `onPress` and with the ref it measures
// to place the menu, and both have to survive the hop through Button — a
// composite component, where they land on the inner Pressable only because it
// spreads its props. Nothing else renders that pair, and the failure is a menu
// that never opens.
test('a dropdown trigger reaches the Pressable inside Button', () => {
  const { UNSAFE_root } = render(
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Link options">
          <Icon as={Upload} />
        </Button>
      </DropdownMenuTrigger>
    </DropdownMenu>,
  );
  // The chain is Slot → Button → Pressable; the last two nodes are the views
  // Pressable itself renders, which carry the resolved classes but no handler.
  const host = UNSAFE_root.findAllByProps({ role: 'button' }).find(
    (node: { props: Record<string, unknown> }) =>
      typeof node.props.onPress === 'function' && typeof node.props.className === 'string',
  );
  expect(host).toBeDefined();
  expect(String(host?.props.className)).toContain('rounded-4xl');
  expect(String(host?.props.className)).toContain('h-9');
});
