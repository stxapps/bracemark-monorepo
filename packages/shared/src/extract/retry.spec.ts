import { EXTRACTION_BACKOFF_BASE_MS, EXTRACTION_BACKOFF_MAX_MS } from '../sync/extraction';
import { isPermanent, verdictForExtractError, verdictForStatus } from './retry';

// The attempt count at which the backoff ladder tops out — the point the 403 rule gives up
// at. Derived, not hardcoded, so a change to the curve moves this with it.
const LADDER_TOP = (() => {
  let attempts = 1;
  while (EXTRACTION_BACKOFF_BASE_MS * 2 ** (attempts - 1) < EXTRACTION_BACKOFF_MAX_MS) attempts++;
  return attempts;
})();

const never = () => {
  throw new Error('priorAttempts must not be read for this status');
};

describe('isPermanent', () => {
  it.each(['blocked', 'unsupported_type', 'too_large'] as const)('is permanent: %s', (error) => {
    expect(isPermanent(error)).toBe(true);
  });

  it.each(['bad_status', 'timeout', 'fetch_failed', undefined] as const)(
    'is transient: %s',
    (error) => {
      expect(isPermanent(error)).toBe(false);
    },
  );
});

describe('verdictForStatus', () => {
  it.each([408, 425, 429, 500, 503, 599])('retries %i', async (status) => {
    await expect(verdictForStatus(status, never)).resolves.toBe('failed');
  });

  it.each([400, 401, 404, 410, 451])('settles %i permanently', async (status) => {
    await expect(verdictForStatus(status, never)).resolves.toBe('permanent');
  });

  // The synthetic codes a client that never got a response reports (bracemark-expo's fetchPage).
  it.each([0, 204, 415])('settles synthetic %i permanently', async (status) => {
    await expect(verdictForStatus(status, never)).resolves.toBe('permanent');
  });

  describe('403 — the bot-wall ladder', () => {
    it('retries while the ladder has room', async () => {
      await expect(verdictForStatus(403, () => 0)).resolves.toBe('failed');
      await expect(verdictForStatus(403, () => LADDER_TOP - 2)).resolves.toBe('failed');
    });

    it('gives up once the ladder has topped out', async () => {
      await expect(verdictForStatus(403, () => LADDER_TOP - 1)).resolves.toBe('permanent');
      await expect(verdictForStatus(403, () => 99)).resolves.toBe('permanent');
    });

    it('awaits an async attempt count', async () => {
      await expect(verdictForStatus(403, () => Promise.resolve(0))).resolves.toBe('failed');
    });
  });
});

describe('verdictForExtractError', () => {
  it('prefers the relayed status over the enum', async () => {
    await expect(verdictForExtractError('bad_status', 404, never)).resolves.toBe('permanent');
    await expect(verdictForExtractError('bad_status', 503, never)).resolves.toBe('failed');
  });

  it('runs the 403 ladder through the contract too', async () => {
    await expect(verdictForExtractError('bad_status', 403, () => 0)).resolves.toBe('failed');
    await expect(verdictForExtractError('bad_status', 403, () => 99)).resolves.toBe('permanent');
  });

  it('falls back to the enum when no status was relayed', async () => {
    await expect(verdictForExtractError('bad_status', undefined, never)).resolves.toBe('failed');
    await expect(verdictForExtractError('blocked', undefined, never)).resolves.toBe('permanent');
  });

  it('ignores a status on errors that never carry one', async () => {
    await expect(verdictForExtractError('too_large', 200, never)).resolves.toBe('permanent');
    await expect(verdictForExtractError('timeout', 200, never)).resolves.toBe('failed');
  });
});
