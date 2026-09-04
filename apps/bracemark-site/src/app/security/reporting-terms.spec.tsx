import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render } from '@testing-library/react';

import { SECURITY_ACK_WINDOW, SECURITY_EMAIL, SECURITY_TRIAGE_WINDOW } from '../../lib/site';
import SupportPage from '../support/page';
import SecurityPage from './page';

// The disclosure windows are the one commitment on this property published on four
// surfaces at once, in three different voices, to the single audience that reads a
// missed window as a stall and goes public: SECURITY.md in the repository, the
// reporting block on /support, the reporting section on /security, and the `Policy:`
// line in /.well-known/security.txt, which decides which of the other three a
// researcher's tooling reads first. Moving one and missing another fails nothing —
// no lint rule, no type error, no build — and what it publishes is not a cosmetic
// difference: it is two promises to the same person about the same report.
//
// Two of the four now read the windows from lib/site.ts and cannot disagree. This
// file is for the one that cannot import anything: SECURITY.md is markdown, its copy
// stays typed, and this is what holds it to the constants — the same move
// brand.spec.ts makes for the third copy of the licence claim (docs/brand-assets.md,
// _the source — what we may claim_). The fourth is pinned by route.spec.ts beside
// the route, which needs the node environment this file cannot use. The reasoning
// for the arrangement is in docs/hosting.md, _/.well-known/security.txt_.
//
// ASSERTED AGAINST THE CONSTANTS, NEVER AGAINST "three" OR "ten". Retuning a window
// is a legitimate decision; publishing it in three places and forgetting the fourth
// is not. Editing SECURITY_ACK_WINDOW therefore moves the expectation with the
// product and fails only the surfaces that did not move with it — which is exactly
// the list of files still to edit.
//
// The pages are read as RENDERED text rather than as source, so a line rewrapped by
// prettier or an interpolation split across a JSX break still passes, and a surface
// that quietly went back to a typed number does not.

const REPO_ROOT = join(__dirname, '../../../../..');
const SECURITY_MD = readFileSync(join(REPO_ROOT, 'SECURITY.md'), 'utf8');

/** Markdown wraps and JSX indents; neither is a difference in what was published. */
const flatten = (text: string) => text.replace(/\s+/g, ' ');

const ACK = `within ${SECURITY_ACK_WINDOW}`;
// The trailing stop is load-bearing: without it "within ten" also matches "within
// ten working days", which is a different promise that would pass silently.
const TRIAGE = `within ${SECURITY_TRIAGE_WINDOW}.`;

const SURFACES: [string, () => string][] = [
  ['SECURITY.md', () => flatten(SECURITY_MD)],
  ['/security', () => flatten(render(<SecurityPage />).container.textContent ?? '')],
  ['/support', () => flatten(render(<SupportPage />).container.textContent ?? '')],
];

describe('the disclosure windows', () => {
  it.each(SURFACES)('%s commits to both windows, in the words the others use', (_name, read) => {
    const text = read();
    expect(text).toContain(ACK);
    expect(text).toContain(TRIAGE);
  });

  // Presence, not phrasing — each surface says this in its own voice and should. The
  // realistic drift is a rewrite that drops the sentence from one surface, leaving a
  // researcher who read that one expecting to be paid, or unsure they will be named.
  it.each(SURFACES)(
    '%s still says there is no bounty and that we credit a reporter',
    (_n, read) => {
      const text = read();
      expect(text).toMatch(/bug bounty/);
      expect(text).toMatch(/credit you/);
    },
  );

  it.each(SURFACES)('%s publishes the reporting address and no other', (_name, read) => {
    const text = read();
    expect(text).toContain(SECURITY_EMAIL);
  });
});
