import { fireEvent, render, screen } from '@testing-library/react';

import { Label } from './label';

// Pins the half of `htmlFor` the browser does NOT do for us. A label reaches only
// the LABELABLE elements; pointed at anything else its click is inert — which is
// what TagsField's `div role="combobox"` trigger was, sitting between a List row
// (a Button, so the browser forwarded) and a Note row (a textarea) that both
// worked. Nothing catches that: it type-checks, it lints, and the field looks
// identical to the two around it. See docs/accessibility.md, _naming things_.
describe('Label htmlFor forwarding', () => {
  it('focuses and clicks a non-labelable target', () => {
    const onClick = jest.fn();
    render(
      <>
        <Label htmlFor="combo">Tags</Label>
        <div id="combo" role="combobox" tabIndex={0} aria-label="Tags" onClick={onClick} />
      </>,
    );

    fireEvent.click(screen.getByText('Tags'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
  });

  it('leaves a labelable target to the browser, without doubling the click', () => {
    const onClick = jest.fn();
    render(
      <>
        <Label htmlFor="btn">List</Label>
        <button id="btn" type="button" onClick={onClick} />
      </>,
    );

    fireEvent.click(screen.getByText('List'));

    // One, not two: label activation already delivered it, and forwarding again
    // would toggle a picker open and straight back shut.
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still runs the caller’s own onClick', () => {
    const onClick = jest.fn();
    render(<Label onClick={onClick}>Plain</Label>);

    fireEvent.click(screen.getByText('Plain'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
