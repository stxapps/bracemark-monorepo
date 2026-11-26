// Whether this app honours the `tagLines` display option (docs/link-layouts.md,
// _heights_). A multi-line tag strip is only safe here if it knows its width at
// its first render — otherwise it grows after FlashList measured the item and the
// list jumps. Settled by the on-device spike in the link-layouts work: while
// `false`, the strip stays one line whatever the synced value says (the value is
// kept, so web still uses it) and the option is hidden on this app.
export const EXPO_TAG_LINES_SUPPORTED = true;
