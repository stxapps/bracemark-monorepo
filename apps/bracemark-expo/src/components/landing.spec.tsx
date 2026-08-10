import * as React from 'react';
import { render } from '@testing-library/react-native';

import { Landing } from './landing';

// Colocated with its source (the workspace convention). This works because the
// landing UI lives in `src/components/` — outside the expo-router app root —
// unlike the thin route at `src/app/index.tsx`, which would become a bogus route
// if a `.spec.tsx` sat next to it.
test('renders correctly', () => {
  const { getByTestId } = render(<Landing />);
  expect(getByTestId('heading')).toHaveTextContent(/Bracemark/);
});
