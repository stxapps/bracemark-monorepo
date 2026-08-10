// Jest has no CSS transformer; the root `_layout.tsx` imports Uniwind's
// `global.css` entry, so map `*.css` to this empty module in tests (see
// jest.config.cts).
module.exports = {};
