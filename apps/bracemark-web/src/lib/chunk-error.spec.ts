import { isChunkLoadError } from './chunk-error';

// The one signal that an open tab, running an older build, asked the newer build's
// worker for a chunk it no longer holds — and so needs the new build rather than a
// retry. Each loader words it differently; a miss here leaves the user on "try
// again", which reruns the same old code.
describe('isChunkLoadError', () => {
  it.each([
    ['webpack', Object.assign(new Error('Loading chunk 812 failed.'), { name: 'ChunkLoadError' })],
    ['webpack CSS', new Error('Loading CSS chunk app-links failed.')],
    ['Chrome', new TypeError('Failed to fetch dynamically imported module: https://x/_next/a.js')],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['Firefox', new TypeError('error loading dynamically imported module')],
  ])('recognises %s', (_name, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ['an ordinary render error', new Error('Cannot read properties of undefined')],
    ['a network failure', new TypeError('Failed to fetch')],
    ['nothing', undefined],
    ['a string', 'Loading chunk 1 failed'],
  ])('ignores %s', (_name, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});
