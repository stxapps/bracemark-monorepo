import { ApiError, apiErrorCode } from './client';

// The sync engine branches on this code to tell a CAPACITY refusal
// (`quota_exceeded`) apart from an ordinary authorization 403 it must still fail
// the cycle on — so a wrong answer here either wedges the queue or swallows a
// real error.
describe('apiErrorCode', () => {
  it('reads bracemark-api’s error code off the body', () => {
    const e = new ApiError(403, JSON.stringify({ error: 'quota_exceeded', message: 'nope' }));
    expect(apiErrorCode(e)).toBe('quota_exceeded');
  });

  it('returns null for a non-JSON body (a proxy’s HTML 403, say)', () => {
    // The case that must not be mistaken for a server verdict: an edge device
    // returning its own 403 would otherwise be read as a quota refusal and
    // silently skip the user's puts.
    expect(apiErrorCode(new ApiError(403, '<html>Forbidden</html>'))).toBeNull();
  });

  it('returns null when the body is JSON without a string error', () => {
    expect(apiErrorCode(new ApiError(500, JSON.stringify({ error: 42 })))).toBeNull();
    expect(apiErrorCode(new ApiError(500, JSON.stringify({})))).toBeNull();
  });

  it('returns null for anything that is not an ApiError', () => {
    expect(apiErrorCode(new Error('network down'))).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
  });
});
