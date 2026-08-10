import * as React from 'react';
import { render } from '@testing-library/react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';

import { TagsSection } from './tags-section';

// The store seam is mocked whole — this spec is about the table's WIRING, not
// the data layer (which is spec'd in expo-react).
jest.mock('@stxapps/expo-react', () => ({
  useTags: jest.fn(),
  useTagMutations: jest.fn(),
}));

const useTagsMock = useTags as jest.Mock;
const useTagMutationsMock = useTagMutations as jest.Mock;

const tag = (id: string, name: string, rank: string) => ({
  item: { id, name, parentId: null, rank },
  depth: 0,
  children: [],
});

beforeEach(() => {
  useTagsMock.mockReturnValue([tag('t1', 'alpha', 'a0'), tag('t2', 'beta', 'a1')]);
  useTagMutationsMock.mockReturnValue({
    create: jest.fn(),
    rename: jest.fn(),
    move: jest.fn(),
    destroy: jest.fn(),
    reorder: jest.fn(),
  });
});

// The gesture itself can't be exercised here (it needs a native runtime), but
// mounting proves the drag layer's hook wiring is legal — `useRow` runs a
// gesture, an animated style and a layout callback per row, so a rows-in-a-map
// mistake or a rules-of-hooks violation fails right here.
test('renders a draggable row per tag', () => {
  const { getAllByLabelText, getByDisplayValue } = render(<TagsSection />);

  expect(getAllByLabelText('Drag to reorder')).toHaveLength(2);
  expect(getByDisplayValue('alpha')).toBeTruthy();
  expect(getByDisplayValue('beta')).toBeTruthy();
});

test('drops the grips along with the rows when there are no tags', () => {
  useTagsMock.mockReturnValue([]);
  const { queryAllByLabelText, getByText } = render(<TagsSection />);

  expect(queryAllByLabelText('Drag to reorder')).toHaveLength(0);
  expect(getByText('No tags yet.')).toBeTruthy();
});
