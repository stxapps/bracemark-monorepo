import { describe, expect, it } from 'vitest';

import { entitlementsOf } from '@stxapps/shared';

import type { FileUsage } from '../do/user-data';
import { HttpError } from './errors';
import { checkPutQuota } from './quota';

// Pure-function coverage of the put-quota gate, which is now ONLY the byte/object
// cost backstop: one error code, no namespace policy, no create-vs-update. The
// free tier's `maxLinks` cap moved to the client, so
// there is no `upgrade_required` to assert here any more — quota.ts's header
// carries why.
//
// The gate reads CURRENT usage and ignores the batch, so these cases are all
// "what is this account already storing?".

const usage = (u: Partial<FileUsage> = {}): FileUsage => ({
  fileCount: 0,
  totalBytes: 0,
  ...u,
});

const free = entitlementsOf('free');
const plus = entitlementsOf('plus');

describe('checkPutQuota', () => {
  it('allows a put on an empty account', () => {
    expect(() => checkPutQuota(free, usage())).not.toThrow();
  });

  it('allows free-tier files/ puts (client-extracted preview images)', () => {
    expect(() => checkPutQuota(free, usage({ fileCount: 10, totalBytes: 1024 }))).not.toThrow();
  });

  it('does not count links — a free account past 200 links still puts', () => {
    // The gate is namespace-blind now. 500 objects is far under maxFiles, so an
    // account well past the old 200-link cap is waved through: that cap lives on
    // the create surfaces, and this is the deliberate honor-system trade.
    expect(() => checkPutQuota(free, usage({ fileCount: 500 }))).not.toThrow();
  });

  it('rejects when the byte quota is already reached (quota_exceeded)', () => {
    const full = usage({ totalBytes: plus.maxBytes });
    try {
      checkPutQuota(plus, full);
      throw new Error('expected checkPutQuota to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).code).toBe('quota_exceeded');
    }
  });

  it('rejects when the object-count cap is reached (quota_exceeded)', () => {
    const full = usage({ fileCount: free.maxFiles });
    try {
      checkPutQuota(free, full);
      throw new Error('expected checkPutQuota to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).code).toBe('quota_exceeded');
    }
  });

  it('applies the PLAN’s ceilings, not one global number', () => {
    // Usage that exhausts free but is unremarkable on plus — the gate is still
    // entitlement-driven even though it no longer gates a plan FEATURE.
    const beyondFree = usage({ totalBytes: free.maxBytes });
    expect(() => checkPutQuota(free, beyondFree)).toThrow(HttpError);
    expect(() => checkPutQuota(plus, beyondFree)).not.toThrow();
  });

  it('refuses at the ceiling rather than one object past it', () => {
    // `>=`, not `>`: the size of what's about to be uploaded is unknown, so the
    // gate stops at the line instead of letting one more unbounded object through.
    expect(() => checkPutQuota(free, usage({ fileCount: free.maxFiles - 1 }))).not.toThrow();
    expect(() => checkPutQuota(free, usage({ fileCount: free.maxFiles }))).toThrow(HttpError);
  });
});
