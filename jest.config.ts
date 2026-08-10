import type { Config } from 'jest';
import { getJestProjectsAsync } from '@nx/jest';

export default async (): Promise<Config> => ({
  projects: await getJestProjectsAsync(),
  // `watchman` is a global option, so the projects' jest.preset.js copy of it
  // does not apply when jest is run from this root config. Same reasoning —
  // see the comment in jest.preset.js.
  watchman: false,
});
