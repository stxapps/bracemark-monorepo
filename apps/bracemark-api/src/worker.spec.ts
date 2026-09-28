import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { sessionsRepo } from './db/repositories/sessions';
import { hashToken, newId } from './lib/ids';
import { SESSION_PURGE_MS } from './services/session';
import worker from './worker';

const DAY_MS = 24 * 60 * 60 * 1000;

// The cron entry the runtime calls (wrangler.jsonc `triggers.crons`). Its sweep's
// rules are pinned in middleware/auth.spec.ts; this pins that the entry is wired
// and actually runs it.
describe('scheduled', () => {
  it('purges session rows past their retention', async () => {
    const tokenHash = await hashToken(`tok_${newId()}`);
    await sessionsRepo(env.SESSIONS_DB).insert({
      id: newId(),
      tokenHash,
      userId: 'u_cron',
      accountDbId: '1',
      expiresAt: Date.now() - SESSION_PURGE_MS - DAY_MS,
    });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await sessionsRepo(env.SESSIONS_DB).findByTokenHash(tokenHash)).toBeNull();
  });
});
