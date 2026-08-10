import { hueFromHost, initialFromHost } from './host-identity';

describe('initialFromHost', () => {
  it('takes the first alphanumeric, uppercased', () => {
    expect(initialFromHost('example.com')).toBe('E');
    expect(initialFromHost('9gag.com')).toBe('9');
    // Leading non-alphanumerics are skipped, not returned.
    expect(initialFromHost('-weird.host')).toBe('W');
  });

  it("falls back to '?' when no alphanumeric exists", () => {
    expect(initialFromHost('---')).toBe('?');
    expect(initialFromHost('')).toBe('?');
  });
});

describe('hueFromHost', () => {
  // Frozen golden values: the hue is a cross-surface recognition cue (web tiles
  // and panels, the expo card panel must all paint the same color for the same
  // host), so the hash may not drift silently. If you change the hash, you are
  // changing every user's colors everywhere at once — do it on purpose.
  it('matches the frozen goldens', () => {
    expect(hueFromHost('example.com')).toBe(99);
    expect(hueFromHost('github.com')).toBe(94);
    expect(hueFromHost('ycombinator.com')).toBe(72);
  });

  it('always lands in [0, 360)', () => {
    for (const host of ['', 'a', 'localhost', 'sub.domain.example.co.uk']) {
      const hue = hueFromHost(host);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
