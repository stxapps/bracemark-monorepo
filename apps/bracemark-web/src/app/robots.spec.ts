// robots.txt is per-tier, and getting it wrong is silent in both directions:
// allow on staging puts a byte-for-byte copy of sign-in and create-account in
// the index on a second registrable domain (dryrunbase.com is as crawlable as
// production), competing with the real pages; deny on production deindexes the
// app. Neither shows up in a build, a lint run or a type check — the file
// compiles and emits a perfectly valid robots.txt either way.
//
// Which is why `ALLOW_INDEXING` is required rather than defaulted, in BOTH
// directions, and why the guard rejects anything but the two exact strings. A
// truthiness check would read `"false"` as allow — the single most likely way to
// write this wrong — and a default would re-create whichever of the two bugs it
// leaned toward the first time an env file is added without the var.
//
// The module decides at IMPORT time, so each case re-imports it in isolation.

const ALLOW = { rules: { userAgent: '*', allow: '/' } };
const DISALLOW = { rules: { userAgent: '*', disallow: '/' } };

// Import app/robots.ts fresh under a given ALLOW_INDEXING value.
function loadRobots(value: string | undefined) {
  const previous = process.env.ALLOW_INDEXING;
  if (value === undefined) delete process.env.ALLOW_INDEXING;
  else process.env.ALLOW_INDEXING = value;

  try {
    let robots!: () => unknown;
    jest.isolateModules(() => {
      robots = (require('./robots') as { default: () => unknown }).default;
    });
    return robots;
  } finally {
    if (previous === undefined) delete process.env.ALLOW_INDEXING;
    else process.env.ALLOW_INDEXING = previous;
  }
}

describe('robots', () => {
  it('opens the site to crawlers on a tier that says so', () => {
    expect(loadRobots('true')()).toEqual(ALLOW);
  });

  it('closes staging off entirely', () => {
    expect(loadRobots('false')()).toEqual(DISALLOW);
  });

  it('refuses to build when the tier never said', () => {
    expect(() => loadRobots(undefined)).toThrow(/ALLOW_INDEXING/);
  });

  // No coercion, no truthiness, no case-folding. Every one of these is a value
  // someone would plausibly write, and reading any of them as an answer is how a
  // tier ends up indexed by accident.
  it.each(['', 'TRUE', 'True', '1', 'yes', 'FALSE', '0', 'no', ' true'])(
    'refuses to build on the near-miss value %p',
    (value) => {
      expect(() => loadRobots(value)).toThrow(/ALLOW_INDEXING/);
    },
  );
});
