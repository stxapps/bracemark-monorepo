import * as React from 'react';
import { render } from '@testing-library/react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';
import { buildTree, type TagItem } from '@stxapps/shared';

import { TagsField } from './tags-field';

jest.mock('@stxapps/expo-react', () => ({
  useTagMutations: jest.fn(),
  useTags: jest.fn(),
}));

const tag = (id: string, name: string, rank: string): TagItem => ({
  id,
  name,
  parentId: null,
  rank,
  createdAt: 0,
  updatedAt: 0,
  path: `tags/${id}.enc`,
});

beforeEach(() => {
  jest
    .mocked(useTags)
    .mockReturnValue(
      buildTree([
        tag('reading', 'Reading', 'a0'),
        tag('work', 'Work', 'a1'),
        tag('recipes', 'Recipes', 'a2'),
        tag('travel', 'Travel', 'a3'),
      ]),
    );
  jest
    .mocked(useTagMutations)
    .mockReturnValue({ findOrCreate: jest.fn() } as unknown as ReturnType<typeof useTagMutations>);
});

test('keeps two independently truncating names and a remainder in one combobox row', () => {
  const { getByRole, getByText, queryByLabelText, queryByText } = render(
    <TagsField value={['reading', 'work', 'recipes', 'travel']} onChange={jest.fn()} />,
  );

  expect(getByRole('combobox', { name: 'Tags: Reading, Work, Recipes, Travel' })).toBeTruthy();
  expect(getByText('Reading,').props.numberOfLines).toBe(1);
  expect(getByText('Work').props.numberOfLines).toBe(1);
  expect(getByText('+2')).toBeTruthy();
  expect(queryByText('Recipes')).toBeNull();
  expect(queryByLabelText(/^Remove /)).toBeNull();
});
