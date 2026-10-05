/**
 * @jest-environment node
 */
// What answers a page load (docs/offline-mode.md, _what answers a navigation_).
// Every wrong turn here is invisible until a bad network: answer too eagerly from
// the cache and a deploy stops reaching people; wait too long for the network and
// a device that holds the whole app shows a blank window instead.

import { answerNavigation, NAVIGATION_TIMEOUT_MS } from './navigation-response';

const page = (status: number, body: string) => new Response(body, { status });
const HELD = 'the precached page';
const precached = jest.fn(() => Promise.resolve<Response | undefined>(page(200, HELD)));
const nothingHeld = () => Promise.resolve(undefined);
// A request that neither fails nor finishes.
const stalled = () => new Promise<Response>(() => undefined);

beforeEach(() => {
  jest.useFakeTimers();
  precached.mockClear();
});
afterEach(() => jest.useRealTimers());

const text = async (answer: Promise<Response>) => (await answer).text();

it('hands over the network’s page when it answers in time, without opening the precache', async () => {
  const answer = answerNavigation({ network: Promise.resolve(page(200, 'latest')), precached });

  expect(await text(answer)).toBe('latest');
  expect(precached).not.toHaveBeenCalled();
});

it('waits the whole timeout for a stalled network, and then opens the precached page', async () => {
  let settled = false;
  const answer = answerNavigation({ network: stalled(), precached });
  void answer.then(() => (settled = true));

  await jest.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS - 1);
  expect(settled).toBe(false);
  expect(precached).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(1);
  expect(await text(answer)).toBe(HELD);
});

it('opens the precached page at once when the network fails, without waiting out the timeout', async () => {
  const answer = answerNavigation({
    network: Promise.reject(new TypeError('Failed to fetch')),
    precached,
  });

  expect(await text(answer)).toBe(HELD);
  expect(jest.getTimerCount()).toBe(0);
});

it('opens the precached page when the origin answers with a server error', async () => {
  const answer = answerNavigation({ network: Promise.resolve(page(503, 'down')), precached });

  expect(await text(answer)).toBe(HELD);
});

it.each([404, 403, 301])(
  'lets a %i from the network stand, precached page or not',
  async (status) => {
    const network = Promise.resolve(new Response(null, { status }));

    expect((await answerNavigation({ network, precached })).status).toBe(status);
    expect(precached).not.toHaveBeenCalled();
  },
);

it('with nothing precached, waits for a slow network past the timeout', async () => {
  let arrive: (response: Response) => void = () => undefined;
  const network = new Promise<Response>((resolve) => (arrive = resolve));
  const answer = answerNavigation({ network, precached: nothingHeld });

  await jest.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS * 2);
  arrive(page(200, 'late'));

  expect(await text(answer)).toBe('late');
});

it('with nothing precached, passes on the network’s failure and its server error', async () => {
  const failure = new TypeError('Failed to fetch');

  await expect(
    answerNavigation({ network: Promise.reject(failure), precached: nothingHeld }),
  ).rejects.toBe(failure);
  expect(
    (await answerNavigation({ network: Promise.resolve(page(500, '')), precached: nothingHeld }))
      .status,
  ).toBe(500);
});

it('still answers from the network when the precache cannot be read', async () => {
  const answer = answerNavigation({
    network: Promise.resolve(page(500, 'origin error')),
    precached: () => Promise.reject(new Error('cache storage unavailable')),
  });

  expect(await text(answer)).toBe('origin error');
});
