import { ApiError } from '../api/client';
import {
  newSessionGeneration,
  SESSION_ERROR,
  SESSION_RETENTION,
  sessionVerdictFromResponse,
  sessionVerdictOf,
} from './sessions';

// The number and the words for it are two copies of one public promise, and
// nothing else compares them. Pinned together, so changing `days` fails here
// until someone has re-read `label` — and /privacy and /delete-account with it.
describe('session record retention', () => {
  it('says the number it keeps', () => {
    expect(SESSION_RETENTION).toEqual({ days: 365, label: 'a year' });
  });
});

// The rule as a table (docs/sessions.md): only our own `session_revoked`
// envelope may lead to a wipe; everything else is a sign-in at most, and most of
// it is just a failed request.
describe('sessionVerdictFromResponse', () => {
  const body = (error: unknown) => JSON.stringify({ error });

  it.each([
    ['session_revoked', 401, body(SESSION_ERROR.revoked), 'revoked'],
    ['session_expired', 401, body(SESSION_ERROR.expired), 'expired'],
    ['session_unknown', 401, body(SESSION_ERROR.unknown), 'expired'],
    ['a codeless 401', 401, '', null],
    ['an HTML 401', 401, '<html><body>401 Unauthorized</body></html>', null],
    ['our envelope with another code', 401, body('unauthorized'), null],
    ['a JSON null body', 401, 'null', null],
    ['session_revoked on a 403', 403, body(SESSION_ERROR.revoked), null],
    ['session_revoked on a 500', 500, body(SESSION_ERROR.revoked), null],
  ])('%s → %s', (_name, status, text, expected) => {
    expect(sessionVerdictFromResponse(status, text)).toBe(expected);
  });
});

describe('sessionVerdictOf', () => {
  it('reads an ApiError', () => {
    expect(sessionVerdictOf(new ApiError(401, '{"error":"session_revoked"}'))).toBe('revoked');
  });

  it('is null for anything that is not our ApiError', () => {
    expect(sessionVerdictOf(new TypeError('Failed to fetch'))).toBeNull();
    expect(sessionVerdictOf({ status: 401, body: '{"error":"session_revoked"}' })).toBeNull();
  });
});

describe('newSessionGeneration', () => {
  it('mints distinct values', () => {
    const seen = new Set(Array.from({ length: 200 }, newSessionGeneration));
    expect(seen.size).toBe(200);
  });
});
