import { createStallMeter } from './stall-probe';

// The stall probe's arithmetic, on a clock the spec moves by hand. Every way it
// can go wrong reads as good news — "no stall" — so each case below pins one way
// a real block could go unseen, and the first pins that one is seen at all.

function meterAt(start = 1000) {
  let t = start;
  const meter = createStallMeter(() => t);
  return {
    meter,
    // Let `ms` of wall time pass, ticking on schedule the whole way (idle thread).
    idle(ms: number) {
      for (let i = 0; i < ms; i += 16) {
        t += 16;
        meter.tick();
      }
    },
    // The thread is busy for `ms`: no tick can run until it is over.
    block(ms: number) {
      t += ms;
    },
    tick() {
      t += 16;
      meter.tick();
    },
  };
}

it('reads a block between two ticks as its length, to within a tick', () => {
  const clock = meterAt();
  clock.meter.begin('import');
  clock.idle(100);
  clock.block(400);
  clock.tick();
  clock.idle(100);

  const reading = clock.meter.end();
  expect(reading?.stalls).toBe(1);
  expect(reading?.longestMs).toBeGreaterThanOrEqual(400 - 16);
  expect(reading?.longestMs).toBeLessThanOrEqual(400 + 16);
  expect(reading?.blockingMs).toBe((reading?.longestMs ?? 0) - 50);
});

it('does not count a block a user would not feel as a stall', () => {
  const clock = meterAt();
  clock.meter.begin('export');
  clock.block(40);
  clock.tick();
  expect(clock.meter.end()).toMatchObject({ stalls: 0, longestMs: 0 });
});

// A scroll's jank: many blocks each under a stall, which the stall count reads as
// a clean run. The dropped frames are what see it — and an idle thread drops none.
it('counts the frames short blocks drop, which no stall shows', () => {
  const clock = meterAt();
  clock.meter.begin('scroll');
  clock.idle(160);
  for (let i = 0; i < 10; i++) {
    clock.block(32);
    clock.tick();
  }
  clock.idle(160);
  expect(clock.meter.end()).toMatchObject({ stalls: 0, droppedFrames: 20 });
});

// The run's LAST chunk resolves the promise whose `finally` closes the window,
// before any tick has run after it. Without the pending-gap arm in `end()` that
// block — often the longest, since it ends in the settle — was never observed.
it('counts the block still in progress when the window closes', () => {
  const clock = meterAt();
  clock.meter.begin('import');
  clock.idle(50);
  clock.block(900);

  expect(clock.meter.end()?.longestMs).toBeGreaterThanOrEqual(900 - 16);
});

it('counts nothing outside a window', () => {
  const clock = meterAt();
  clock.block(2000);
  clock.tick();
  clock.meter.begin('import');
  clock.idle(100);
  expect(clock.meter.end()).toMatchObject({ stalls: 0 });
});

// The calibration closes its window by label, so a run that opened one in the
// meantime keeps it — and its reading — instead of losing both to the
// calibration's timer.
it("leaves another label's window open", () => {
  const clock = meterAt();
  clock.meter.begin('import');
  expect(clock.meter.end('calibration')).toBeNull();
  expect(clock.meter.isOpen()).toBe(true);
  expect(clock.meter.end('import')?.label).toBe('import');
});
