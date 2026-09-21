// How long a `past_due` subscription stays entitled past its period end while
// the provider retries payment (Paddle dunning runs up to ~2 weeks). Yanking
// features mid-dunning punishes an expired card harder than a deliberate cancel.
//
// One policy for every provider, applied by the fold (services/iap.ts). It lives
// here rather than beside the fold because lib/appstore.ts needs it too: Apple's
// billing grace period is a SECOND window measured from the same expiry, and the
// snapshot has to fold it into this one instead of stacking the two
// (docs/iap.md — _the fold_).
export const PAST_DUE_GRACE_MS = 16 * 24 * 60 * 60 * 1000;
