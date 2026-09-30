import { render, screen } from '@testing-library/react';

import { SettingsNotice, SettingsPane } from './settings-kit';

// Pins which tone is allowed to move the page. The failure is silent both ways:
// drop the `error` branch and a failure reported from deep in a long section is
// never seen (the bug this replaced — the Lists table's rename and move report
// into a notice above the table); widen it to every tone and a standing banner
// yanks the viewport out from under someone who was reading something else.
//
// jsdom implements no layout, so `scrollIntoView` does not exist on its
// elements — the stub below is what lets this render at all, and it is also the
// assertion. The real movement was driven on a simulator/browser instead
// (docs/testing.md, _what earns a spec_).
const scrollIntoView = jest.fn();
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
});
beforeEach(() => scrollIntoView.mockClear());

test('an error notice brings itself into view when it appears', () => {
  render(<SettingsNotice tone="error">Could not save. The local store is full.</SettingsNotice>);

  expect(screen.getByRole('alert')).toBeTruthy();
  // Not a count: StrictMode (docs/testing.md) runs the mount effect twice.
  expect(scrollIntoView).toHaveBeenCalled();
  // `nearest`, so a notice already on screen does not move the page at all.
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
});

test('a new message on a notice already mounted brings it into view again', () => {
  // The component stays mounted across errors — the section re-renders it with
  // new text — so mounting alone would only ever catch the first failure.
  const { rerender } = render(<SettingsNotice tone="error">First failure.</SettingsNotice>);
  // Counted from the mount — StrictMode runs the mount effect twice.
  const mounted = scrollIntoView.mock.calls.length;
  rerender(<SettingsNotice tone="error">Second, different failure.</SettingsNotice>);

  expect(scrollIntoView).toHaveBeenCalledTimes(mounted + 1);
});

test.each(['info', 'pending'] as const)('a %s notice never moves the page', (tone) => {
  // Standing text, not an event: these mount with the section (a recovery-code
  // caution, "Finishing your upgrade…") and nobody asked to be taken to them.
  render(<SettingsNotice tone={tone}>You haven’t set up a recovery code.</SettingsNotice>);

  expect(scrollIntoView).not.toHaveBeenCalled();
});

// A sub-view (Account → Change password) swaps the pane's content in place, so
// nothing navigates and the layout's `<main>` keeps the overview's offset unless
// the pane resets it. Silent when lost: the new view just arrives mid-page.
describe('SettingsPane viewKey', () => {
  function renderInMain(viewKey: string) {
    const ui = (key: string) => (
      <main>
        <SettingsPane viewKey={key}>{key}</SettingsPane>
      </main>
    );
    const result = render(ui(viewKey));
    const main = result.container.querySelector('main') as HTMLElement;
    main.scrollTo = jest.fn();
    return { main, rerender: (key: string) => result.rerender(ui(key)) };
  }

  test('a view change scrolls the page back to the top', () => {
    const { main, rerender } = renderInMain('overview');
    rerender('change-password');

    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  test('a re-render on the same view leaves the page where it is', () => {
    const { main, rerender } = renderInMain('overview');
    rerender('overview');

    expect(main.scrollTo).not.toHaveBeenCalled();
  });
});
