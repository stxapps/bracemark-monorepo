import * as React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

import { SettingsRow } from './settings-kit';

// SettingsRow's `footer` must not change the row's tree. Read mode's images switch
// shows and hides its own footer, so a row that changed shape around its action
// remounted that switch on every flip — a new native UISwitch replacing the one
// mid-spring, seen as a stutter on device and by nothing else.

jest.mock('./scroll-host', () => ({ useSettingsScroll: () => null }));

test('the action stays mounted as a footer comes and goes', () => {
  let mounts = 0;
  function Action() {
    React.useEffect(() => {
      mounts += 1;
    }, []);
    return <Text>action</Text>;
  }
  const row = (footer: boolean) => (
    <SettingsRow
      title="Title"
      description="Description"
      action={<Action />}
      footer={footer ? <Text>Footer</Text> : null}
    />
  );

  const { rerender } = render(row(false));
  rerender(row(true));
  rerender(row(false));

  expect(mounts).toBe(1);
});
