import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT } from '../paths';
import { inherit } from './process';

const pointer = JSON.parse(
  await readFile(join(E2E_ROOT, '.artifacts', 'latest-web-run.json'), 'utf8'),
) as { runDir: string };

await inherit('playwright', ['show-report', join(pointer.runDir, 'report')], { cwd: E2E_ROOT });
