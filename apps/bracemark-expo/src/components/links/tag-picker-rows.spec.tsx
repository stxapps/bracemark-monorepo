import * as React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { TagPickerCreateRow, TagPickerItem } from './tag-picker-rows';

test('renders full-width checkbox rows with persistent checked state', () => {
  const onToggle = jest.fn();
  const { getByTestId } = render(
    <>
      <TagPickerItem
        row={{ id: 'reading', name: 'Reading', selected: true }}
        testID="tag-reading"
        onToggle={onToggle}
      />
      <TagPickerItem
        row={{ id: 'work', name: 'Work', selected: false }}
        testID="tag-work"
        onToggle={onToggle}
      />
    </>,
  );

  expect(getByTestId('tag-reading').props.accessibilityState.checked).toBe(true);
  expect(getByTestId('tag-work').props.accessibilityState.checked).toBe(false);
  fireEvent.press(getByTestId('tag-work'));
  expect(onToggle).toHaveBeenCalledWith('work');
});

test('the Create row names what it will create, and holds while a create lands', () => {
  const onCreate = jest.fn();
  const { getByText, getByRole, rerender } = render(
    <TagPickerCreateRow name="Reading" onCreate={onCreate} />,
  );
  expect(getByText('Create “Reading”')).toBeTruthy();
  fireEvent.press(getByRole('button', { name: 'Create tag Reading' }));
  expect(onCreate).toHaveBeenCalledTimes(1);

  rerender(<TagPickerCreateRow name="Reading" creating onCreate={onCreate} />);
  fireEvent.press(getByRole('button', { name: 'Create tag Reading' }));
  expect(onCreate).toHaveBeenCalledTimes(1);
});
