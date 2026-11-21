// A new query starts the picker at the top (picker-scroller.tsx, _a new query
// starts at the top_). Without it a list scrolled down and then filtered shows
// its matches from the old offset — the first ones hidden above the box — and
// nothing fails: the rows are all there, just out of sight.

import { FlatList, Text } from 'react-native';
import { render } from '@testing-library/react-native';

import { PickerScroller } from './picker-scroller';

const rows = Array.from({ length: 50 }, (_, i) => `row-${i}`);

function Picker({ resetKey }: { resetKey: string }) {
  return (
    <PickerScroller
      data={rows}
      renderItem={({ item }) => <Text>{item}</Text>}
      keyExtractor={(item) => item}
      className="max-h-80"
      scrollResetKey={resetKey}
    />
  );
}

afterEach(() => jest.restoreAllMocks());

test('a changed query scrolls back to the top; an unchanged one does not', () => {
  const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset');
  const { rerender } = render(<Picker resetKey="" />);
  expect(scrollToOffset).not.toHaveBeenCalled();

  rerender(<Picker resetKey="" />);
  expect(scrollToOffset).not.toHaveBeenCalled();

  rerender(<Picker resetKey="wo" />);
  expect(scrollToOffset).toHaveBeenCalledTimes(1);
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });

  rerender(<Picker resetKey="" />);
  expect(scrollToOffset).toHaveBeenCalledTimes(2);
});
