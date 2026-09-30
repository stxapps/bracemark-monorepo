// Every @testing-library/react render mounts under <StrictMode>, as the web
// surfaces themselves do: Next's app router turns StrictMode on in `next dev`
// (bracemark-web, bracemark-site), and the browser extension's popup and options
// pages wrap their roots in it explicitly. StrictMode's mount → cleanup → mount
// reuses every ref, so a cleanup that leaves one in a state the next mount can't
// start from — an "unmounted" flag nothing resets, a single-flight ref still
// held by a cancelled run — breaks the page in dev and passes a single-mount spec
// (docs/testing.md, _specs mount under StrictMode_).
//
// Listed in `setupFilesAfterEnv` by each web project's jest config rather than in
// jest.preset.js, which the expo projects share too: they render through
// @testing-library/react-native, which has no such switch.
const { configure } = require('@testing-library/react');

configure({ reactStrictMode: true });
