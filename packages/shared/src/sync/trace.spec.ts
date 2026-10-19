// The sync trace's numbers are what a person decides a sync optimization by
// (docs/local-first-sync.md, _measuring a sync_), so the arithmetic that turns
// spans into "wall" and "in flight" is the part worth pinning: a union that
// double-counted overlap would report a starved fan-out as a healthy one. The
// rest is the recording contract — a failed body still records its time, and a
// retried call reads as one span per attempt.

import { type ApiClient, ApiError } from '../api/client';
import { defineEndpoint } from '../api/endpoint';
import { withRetry } from '../api/retry';
import { z } from '../zod';
import { createSyncTraceRecorder, NO_TRACE, summarizeSyncTrace, traceApi } from './trace';

describe('summarizeSyncTrace', () => {
  it('counts overlapping spans once on the clock and fully in the work', () => {
    // Three PUTs: two overlapping over [0, 100], one alone over [200, 250].
    const rows = summarizeSyncTrace([
      { name: 'blob.put', start: 0, end: 100 },
      { name: 'blob.put', start: 50, end: 100 },
      { name: 'blob.put', start: 200, end: 250, attrs: { bytes: 10 } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'blob.put',
      count: 3,
      totalMs: 200,
      wallMs: 150,
      maxMs: 100,
      bytes: 10,
    });
    expect(rows[0].concurrency).toBeCloseTo(200 / 150);
  });

  it('keeps only the spans that overlap the window', () => {
    const rows = summarizeSyncTrace(
      [
        { name: 'cycle', start: 0, end: 10 },
        { name: 'cycle', start: 100, end: 200 },
      ],
      { since: 50 },
    );
    expect(rows[0]).toMatchObject({ count: 1, wallMs: 100 });
  });
});

describe('createSyncTraceRecorder', () => {
  it('records a failed body with its error name, and still rethrows', async () => {
    let clock = 0;
    const trace = createSyncTraceRecorder({ now: () => (clock += 5) });
    await expect(
      trace.span('blob.put', async () => {
        throw new TypeError('offline');
      }),
    ).rejects.toThrow('offline');
    expect(trace.spans).toEqual([{ name: 'blob.put', start: 5, end: 10, failed: 'TypeError' }]);
  });

  it('merges attributes noted inside the body with the ones passed in', async () => {
    const trace = createSyncTraceRecorder();
    await trace.span(
      'blob.put',
      async (note) => {
        note({ bytes: 42 });
      },
      { ns: 'links' },
    );
    expect(trace.spans[0].attrs).toEqual({ ns: 'links', bytes: 42 });
  });

  it('refuses spans past its bound and counts them', () => {
    const trace = createSyncTraceRecorder({ maxSpans: 1 });
    trace.record({ name: 'a', start: 0, end: 1 });
    trace.record({ name: 'b', start: 0, end: 1 });
    expect(trace.spans.map((s) => s.name)).toEqual(['a']);
    expect(trace.dropped).toBe(1);
  });
});

describe('traceApi', () => {
  const endpoint = defineEndpoint({
    method: 'POST',
    path: '/v1/files/sign',
    request: z.object({}),
    response: z.object({}),
  });

  it('hands back the same client when tracing is off', () => {
    const api: ApiClient = { call: jest.fn() };
    expect(traceApi(api, NO_TRACE)).toBe(api);
  });

  it('records one span per attempt under withRetry, the 429 with its hint', async () => {
    const call = jest
      .fn()
      .mockRejectedValueOnce(new ApiError(429, '{}', 1))
      .mockResolvedValueOnce({});
    const trace = createSyncTraceRecorder();
    const api = withRetry(traceApi({ call }, trace), { sleep: async () => undefined });

    await api.call(endpoint, {});

    expect(trace.spans.map((s) => [s.name, s.attrs, s.failed])).toEqual([
      ['api /v1/files/sign', { status: 429, retryAfterMs: 1000 }, 'ApiError'],
      ['api /v1/files/sign', undefined, undefined],
    ]);
  });
});
