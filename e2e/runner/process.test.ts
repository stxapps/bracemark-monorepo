import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capture } from './process';

test(
  'a stalled preflight command is killed rather than holding the runner indefinitely',
  { timeout: 2000 },
  async () => {
    await assert.rejects(
      capture(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        {
          timeoutMs: 250,
        },
      ),
      (error: unknown) => {
        const result = error as { killed?: boolean; signal?: string };
        return result.killed === true && result.signal === 'SIGKILL';
      },
    );
    assert.equal(
      (
        await capture(process.execPath, ['-e', 'process.stdout.write("ready")'], {
          timeoutMs: 5000,
        })
      ).stdout,
      'ready',
    );
  },
);
