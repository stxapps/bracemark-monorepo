import * as React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { type LinkView } from '@stxapps/expo-react';

import { LinkTagChips } from './link-tag-chips';

type TestNode = {
  props: {
    onLayout?: unknown;
    hitSlop?: { top?: number; bottom?: number };
  };
};

jest.mock('../../lib/font-scale', () => ({
  allowsFontScaling: () => true,
  MAX_FONT_SIZE_MULTIPLIER: 1.3,
  useCappedFontScale: () => 1,
}));
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ setSimpleQuery: jest.fn() }),
}));
jest.mock('./shared', () => ({
  useEngagedOpen: () => [false, jest.fn()],
}));

const link: LinkView = {
  path: 'links/link.enc',
  url: 'https://example.com',
  listId: 'list',
  tagIds: ['alpha', 'beta', 'gamma'],
  createdAt: 0,
  updatedAt: 0,
};

test('starts conservatively, then expands from its own measured width', () => {
  const { UNSAFE_root, getByText, queryByText } = render(
    <LinkTagChips
      link={link}
      tagsById={new Map([
        ['alpha', 'Alpha'],
        ['beta', 'Beta'],
        ['gamma', 'Gamma'],
      ])}
      selectMode={false}
    />,
  );

  expect(getByText('Alpha')).toBeTruthy();
  expect(getByText('+2')).toBeTruthy();
  expect(queryByText('Beta')).toBeNull();

  const layoutNode = UNSAFE_root.findAll(
    (node: TestNode) => typeof node.props.onLayout === 'function',
  )[0];
  fireEvent(layoutNode, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 24 } },
  });

  expect(getByText('Beta')).toBeTruthy();
  expect(getByText('Gamma')).toBeTruthy();
  expect(queryByText('+2')).toBeNull();
  const enlargedTargets = UNSAFE_root.findAll(
    (node: TestNode) => node.props.hitSlop !== undefined,
  );
  expect(enlargedTargets.length).toBeGreaterThanOrEqual(3);
  expect(enlargedTargets.every((node: TestNode) => node.props.hitSlop?.top === 10)).toBe(true);
  expect(enlargedTargets.every((node: TestNode) => node.props.hitSlop?.bottom === 10)).toBe(true);
});
