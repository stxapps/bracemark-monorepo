import * as React from 'react';
import { act, render } from '@testing-library/react-native';

import { DragHandle, DragRow, type DragSort, type DragSortOptions, useDragSort } from './drag-sort';

// The shared setup stubs gesture-handler down to a builder that swallows its
// callbacks (a real gesture needs a native runtime). This spec is about what
// those callbacks DO, so its builder keeps them: `handlers` is the four worklets
// a row's pan was built with, which under jest are plain functions.
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const handlers: Record<string, unknown> = {};
    const builder: unknown = new Proxy(
      {},
      {
        get: (_target, prop: string) =>
          prop === 'handlers'
            ? handlers
            : (arg: unknown) => {
                if (typeof arg === 'function') handlers[prop] = arg;
                return builder;
              },
      },
    );
    return builder;
  };
  return {
    Gesture: { Pan: pan },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

interface PanHandlers {
  onStart: () => void;
  onUpdate: (e: { translationY: number; translationX: number; absoluteY: number }) => void;
  onEnd: () => void;
  onFinalize: () => void;
}

// The pan each row currently carries, by row id — refreshed every render, since
// a row whose index moves rebuilds its gesture.
const pans = new Map<string, PanHandlers>();

function Row({ id, index, drag }: { id: string; index: number; drag: DragSort }) {
  const { pan, style, onLayout } = drag.useRow(index);
  pans.set(id, (pan as unknown as { handlers: PanHandlers }).handlers);
  return (
    <DragRow style={style} onLayout={onLayout}>
      <DragHandle pan={pan} />
    </DragRow>
  );
}

type TableProps = { ids: string[] } & Pick<DragSortOptions, 'onDrop' | 'onPickUp' | 'onRelease'>;

function Table({ ids, ...callbacks }: TableProps) {
  const drag = useDragSort({ count: ids.length, orderKey: ids.join(' '), ...callbacks });
  return (
    <>
      {ids.map((id, index) => (
        <Row key={id} id={id} index={index} drag={drag} />
      ))}
    </>
  );
}

// The fallback row height (no layout under jest), so a drag of one row's worth
// lands exactly one slot down.
const ROW = 44;
// Comfortably past the landing animation and short of the commit timeout.
const LANDED_MS = 500;
const PAST_TIMEOUT_MS = 2500;

// One hop between the two runtimes. Under jest both directions are queued on the
// fake clock (worklets' own note in `runOnUI` says why), so a callback the hook
// schedules across has not run until the clock moves.
const HOP_MS = 20;

// Pick `id` up, carry it `slots` rows down and let go — the four callbacks a real
// pan fires, in the order it fires them — and let the drop reach the JS side.
function dragAndDrop(id: string, slots: number) {
  const pan = pans.get(id);
  if (!pan) throw new Error(`no row ${id}`);
  act(() => {
    pan.onStart();
    pan.onUpdate({ translationY: slots * ROW, translationX: 0, absoluteY: 0 });
    jest.advanceTimersByTime(HOP_MS);
    pan.onEnd();
    pan.onFinalize();
    jest.advanceTimersByTime(HOP_MS);
  });
}

const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));

beforeEach(() => {
  jest.useFakeTimers();
  pans.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

const pending = () => new Promise<void>(() => undefined);

test('a drop that writes is held until the rows re-render in the new order', () => {
  const onDrop = jest.fn(() => pending());
  const onRelease = jest.fn();
  const { rerender } = render(
    <Table ids={['a', 'b', 'c']} onDrop={onDrop} onRelease={onRelease} />,
  );

  dragAndDrop('a', 1);
  expect(onDrop).toHaveBeenCalledWith(0, 1, 0);

  // The landing is long over and the store hasn't answered: releasing here is
  // the snap-back — every row back at identity over the OLD order.
  advance(LANDED_MS);
  expect(onRelease).not.toHaveBeenCalled();

  rerender(<Table ids={['b', 'a', 'c']} onDrop={onDrop} onRelease={onRelease} />);
  expect(onRelease).toHaveBeenCalledTimes(1);
});

test('a drop that changes nothing goes home without waiting for a re-render', () => {
  const onRelease = jest.fn();
  render(<Table ids={['a', 'b', 'c']} onDrop={() => undefined} onRelease={onRelease} />);

  dragAndDrop('a', 1);
  advance(LANDED_MS);

  expect(onRelease).toHaveBeenCalledTimes(1);
});

test('a refused write sends the row home', async () => {
  const onRelease = jest.fn();
  render(
    <Table
      ids={['a', 'b', 'c']}
      onDrop={() => Promise.reject(new Error('store failed'))}
      onRelease={onRelease}
    />,
  );

  dragAndDrop('a', 1);
  // The rejection is a microtask; the trip home is timers.
  await act(async () => undefined);
  advance(LANDED_MS);

  expect(onRelease).toHaveBeenCalledTimes(1);
});

test('a write that lands and moves nothing is given up on, not held forever', () => {
  const onRelease = jest.fn();
  render(<Table ids={['a', 'b', 'c']} onDrop={() => pending()} onRelease={onRelease} />);

  dragAndDrop('a', 1);
  advance(LANDED_MS);
  expect(onRelease).not.toHaveBeenCalled();

  advance(PAST_TIMEOUT_MS);
  expect(onRelease).toHaveBeenCalledTimes(1);
});

test('a row cannot be picked up while the previous drop is still held', () => {
  const onPickUp = jest.fn();
  const onDrop = jest.fn(() => pending());
  const { rerender } = render(<Table ids={['a', 'b', 'c']} onDrop={onDrop} onPickUp={onPickUp} />);

  dragAndDrop('a', 1);
  advance(LANDED_MS);
  expect(onPickUp).toHaveBeenCalledTimes(1);

  // Held: these indices are about to change under any drag that starts now.
  dragAndDrop('c', -1);
  advance(LANDED_MS);
  expect(onPickUp).toHaveBeenCalledTimes(1);
  expect(onDrop).toHaveBeenCalledTimes(1);

  // The positive control — once the order has rendered, the same press lifts.
  rerender(<Table ids={['b', 'a', 'c']} onDrop={onDrop} onPickUp={onPickUp} />);
  advance(HOP_MS);
  dragAndDrop('c', -1);
  expect(onPickUp).toHaveBeenCalledTimes(2);
  expect(onPickUp).toHaveBeenLastCalledWith(2);
  expect(onDrop).toHaveBeenLastCalledWith(2, 1, 0);
});
