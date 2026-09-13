import * as React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { TagPickerRows } from './tag-picker-rows';

test('renders full-width checkbox rows with persistent checked state', () => {
  const onToggle = jest.fn();
  const { getByTestId } = render(
    <TagPickerRows
      rows={[
        { id: 'reading', name: 'Reading', selected: true },
        { id: 'work', name: 'Work', selected: false },
      ]}
      onToggle={onToggle}
      testIDForRow={(row) => `tag-${row.id}`}
    />,
  );

  expect(getByTestId('tag-reading').props.accessibilityState.checked).toBe(true);
  expect(getByTestId('tag-work').props.accessibilityState.checked).toBe(false);
  fireEvent.press(getByTestId('tag-work'));
  expect(onToggle).toHaveBeenCalledWith('work');
});

test('shows the empty state only when there is no create action', () => {
  const { getByText, queryByText, rerender } = render(
    <TagPickerRows rows={[]} onToggle={jest.fn()} emptyText="No tags found." />,
  );
  expect(getByText('No tags found.')).toBeTruthy();

  rerender(
    <TagPickerRows
      rows={[]}
      onToggle={jest.fn()}
      emptyText="No tags found."
      createName="Reading"
      onCreate={jest.fn()}
    />,
  );
  expect(queryByText('No tags found.')).toBeNull();
  expect(getByText('Create “Reading”')).toBeTruthy();
});
