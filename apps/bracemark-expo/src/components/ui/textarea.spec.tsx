import * as React from 'react';
import { render } from '@testing-library/react-native';

import { Textarea } from './textarea';

// What this file guards is the SEAM, not the values: `Textarea` is four
// overrides spread over `Input`'s base string (its header carries the
// argument), and tailwind-merge decides which of the two survives. Every case
// below is a class the base still holds after the merge — a valid class on a
// valid control, so there is no lint error, no type error and no failing render
// to find it. Asserting on the className the TextInput receives, for
// button.spec.tsx's reason: uniwind resolves it to styles at runtime, but what
// the merge decides IS the class, and that keeps the test off a native style
// snapshot.
//
// No case here passes a `className` of its own, and it is not an omission: that
// prop reaches these components through uniwind's augmentation in
// `uniwind-env.d.ts`, which `tsconfig.spec.json` doesn't include — so a spec
// that hands one over compiles in the app and fails `nx typecheck` (the note in
// button.spec.tsx, arrived at from the other side). Nothing is lost. A call
// site's own class winning is tailwind-merge's behaviour, not this file's, and
// re-testing a dependency is what docs/testing.md, _what earns a spec_, calls
// dilution; what IS this file's is which of the base's classes it has to
// cancel, and that needs no call-site class to state.
function classesOf(ui: React.ReactElement): string[] {
  const { getByLabelText } = render(ui);
  return String(getByLabelText('Note').props.className ?? '')
    .split(/\s+/)
    .filter(Boolean);
}

test("the box takes the tall-control radius, not Input's pill", () => {
  const cls = classesOf(<Textarea aria-label="Note" />);
  expect(cls).toContain('rounded-xl');
  expect(cls).not.toContain('rounded-4xl');
});

test("the floor replaces Input's fixed height at BOTH variant scopes", () => {
  const cls = classesOf(<Textarea aria-label="Note" />);
  expect(cls).toEqual(expect.arrayContaining(['h-auto', 'sm:h-auto', 'min-h-16']));
  // The unscoped half is what tailwind-merge cancels on its own; `sm:h-9` is
  // the half it does NOT, because a different variant scope is not a conflict.
  // Left standing, a note collapses to 36pt on the first screen wide enough to
  // match `sm:` — which no device this app ships to is yet.
  expect(cls).not.toContain('h-10');
  expect(cls).not.toContain('sm:h-9');
});
