// Specs for `untilAborted`: it stops the WAIT and nothing else — the promise's own
// outcome passes through untouched when it comes first, an abort rejects at once
// whatever the promise is doing, and a settled wait leaves no listener behind on a
// signal that may outlive it.

import { untilAborted } from './until-aborted';

describe('untilAborted', () => {
  it('passes the value and the rejection through when the promise settles first', async () => {
    const signal = new AbortController().signal;
    await expect(untilAborted(Promise.resolve('done'), signal)).resolves.toBe('done');
    await expect(untilAborted(Promise.reject(new Error('offline')), signal)).rejects.toThrow(
      'offline',
    );
  });

  it('rejects with the abort reason while the promise is still pending', async () => {
    const controller = new AbortController();
    const waiting = untilAborted(new Promise<void>(() => undefined), controller.signal);

    controller.abort(new Error('too slow'));

    await expect(waiting).rejects.toThrow('too slow');
  });

  it('rejects at once on a signal that has already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('too slow'));

    await expect(untilAborted(Promise.resolve('done'), controller.signal)).rejects.toThrow(
      'too slow',
    );
  });

  it('removes its listener once the promise settles', async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');

    await untilAborted(Promise.resolve('done'), controller.signal);

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
