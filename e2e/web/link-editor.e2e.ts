import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { isNarrow } from './fixtures/layout';
import {
  addLink,
  addLinkButton,
  chooseRowMenuItem,
  createListInPicker,
  createTagInPicker,
  displayUrl,
  linkRow,
  openSidebarItem,
} from './fixtures/links';

// The two link editors against a real Dexie. What a component spec cannot reach
// is the round trip: the create surface and the edit dialog each write through
// useLinkMutations, the pickers mint lists and tags immediately, and the edited
// record has to come back out of IndexedDB after a reload with every field the
// dialog wrote. Validation, the Save → Confirm relabel and the patch builder's
// no-op rule stay in the component specs (docs/editors.md, _invariants_).
test.describe('link editors', () => {
  test(
    'a link created with list, tags and note keeps its edited values after reload',
    { tag: ['@LINK-EDITOR-001', '@full', '@online'] },
    async ({ page }) => {
      const url = unresolvableUrl(unique('editor'));
      const firstList = unique('E2e editor list');
      const movedList = unique('E2e editor moved list');
      const keptTag = unique('e2e-kept-tag');
      const droppedTag = unique('e2e-dropped-tag');
      const addedTag = unique('e2e-added-tag');
      const firstNote = unique('Created with a note');
      const title = unique('Edited title');
      const editedNote = unique('Edited note');

      // --- create: URL plus the three optional fields -------------------------
      await page.goto('/links');
      await addLinkButton(page).click();
      await page.locator('#link-url').fill(url);
      await page.getByRole('button', { name: 'List, tags & note' }).click();
      await createListInPicker(page, page, firstList);
      await createTagInPicker(page, page, keptTag);
      await createTagInPicker(page, page, droppedTag);
      await page.getByRole('textbox', { name: 'Note' }).fill(firstNote);
      await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
      await expect(page.locator('#link-url')).toHaveCount(0);

      // Filed into the chosen list, so it is there and not in the view it was
      // added from.
      await openSidebarItem(page, firstList);
      await expect(linkRow(page, url)).toHaveCount(1);

      // --- edit: every user-authored text/taxonomy field ----------------------
      await chooseRowMenuItem(page, url, 'Edit');
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await expect(dialog.getByRole('combobox', { name: 'List' })).toContainText(firstList);
      await expect(dialog.getByRole('textbox', { name: 'Note' })).toHaveValue(firstNote);

      await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
      await createListInPicker(dialog, page, movedList);
      await dialog.getByRole('button', { name: `Remove ${droppedTag}` }).click();
      await createTagInPicker(dialog, page, addedTag);
      await dialog.getByRole('textbox', { name: 'Note' }).fill(editedNote);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // --- persistence: a real reload, then read every field back -------------
      await page.reload();
      await openSidebarItem(page, firstList);
      await expect(linkRow(page, url)).toHaveCount(0);

      await openSidebarItem(page, movedList);
      const row = linkRow(page, url);
      await expect(row).toHaveCount(1);
      // The custom title replaces the URL fallback on the row itself.
      await expect(row).toContainText(title);
      await expect(row).not.toContainText(displayUrl(url));

      await chooseRowMenuItem(page, url, 'Edit');
      const reopened = page.getByRole('dialog', { name: 'Edit link' });
      await expect(reopened.getByRole('textbox', { name: 'Title' })).toHaveValue(title);
      await expect(reopened.getByRole('combobox', { name: 'List' })).toContainText(movedList);
      await expect(reopened.getByRole('button', { name: `Remove ${keptTag}` })).toBeVisible();
      await expect(reopened.getByRole('button', { name: `Remove ${addedTag}` })).toBeVisible();
      await expect(reopened.getByRole('button', { name: `Remove ${droppedTag}` })).toHaveCount(0);
      await expect(reopened.getByRole('textbox', { name: 'Note' })).toHaveValue(editedNote);
    },
  );

  test(
    'a dirty editor refuses an accidental close and permits an explicit discard',
    { tag: ['@LINK-CLOSE-001', '@full', '@online'] },
    async ({ page }) => {
      // The anchor is what makes the absence assertions below mean something: a
      // reloaded page that has not read Dexie yet shows no rows at all, so
      // "the discarded link is not listed" is only evidence once a link that
      // WAS saved is.
      const anchor = unresolvableUrl(unique('close-anchor'));
      const discarded = unresolvableUrl(unique('close-discarded'));
      const draftNote = unique('Draft note that must not save');

      await page.goto('/links');
      await addLink(page, anchor);

      // --- quick-add ------------------------------------------------------------
      // A bare typed URL is deliberately NOT dirty; the optional fields are.
      await addLinkButton(page).click();
      await page.locator('#link-url').fill(discarded);
      await page.getByRole('button', { name: 'List, tags & note' }).click();
      await page.getByRole('textbox', { name: 'Note' }).fill(draftNote);

      // The two accidental vectors of the anchored popover: Escape, and a press
      // outside it. The outside press lands on the topbar's title, which is not
      // a control, so a refused close is the only thing it can cause. Narrow,
      // quick-add is a bottom sheet (link-add-surface.tsx) over an overlay that
      // takes the press instead — and the title there is the drawer's button,
      // under that overlay — so the press is the overlay's top-left corner,
      // above a sheet capped at 85dvh.
      //
      // Asserted on Radix's `data-state`, NOT on the form still being visible.
      // A popover that DID close keeps its content mounted for the length of its
      // exit animation, so `toBeVisible`/`toHaveValue` pass on their first poll
      // against a surface that is already leaving — measured: with the guard
      // removed, both passed and the run only failed later, on a missing Cancel.
      // `data-state` flips to `closed` in the same render that starts the exit.
      const quickAdd = page.getByRole('dialog').filter({ has: page.locator('#link-url') });
      await page.keyboard.press('Escape');
      await expect(quickAdd).toHaveAttribute('data-state', 'open');
      if (isNarrow(page)) await page.mouse.click(4, 4);
      else await page.locator('h1').first().click();
      await expect(quickAdd).toHaveAttribute('data-state', 'open');
      await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue(draftNote);

      // The explicit discard.
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('#link-url')).toHaveCount(0);

      // --- the edit dialog ------------------------------------------------------
      await chooseRowMenuItem(page, anchor, 'Edit');
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await dialog.getByRole('textbox', { name: 'Note' }).fill(draftNote);

      // `data-state` again, for the exit-animation reason above.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveAttribute('data-state', 'open');
      // The overlay covers the viewport; its corner is outside the centred
      // dialog at any size this suite launches.
      await page.mouse.click(4, 4);
      await expect(dialog).toHaveAttribute('data-state', 'open');
      await expect(dialog.getByRole('textbox', { name: 'Note' })).toHaveValue(draftNote);

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // --- nothing was written, as seen after a reload --------------------------
      await page.reload();
      await expect(linkRow(page, anchor)).toHaveCount(1);
      await expect(page.getByText(displayUrl(discarded))).toHaveCount(0);
      await expect(linkRow(page, anchor).getByLabel('Has note')).toHaveCount(0);

      await chooseRowMenuItem(page, anchor, 'Edit');
      await expect(
        page.getByRole('dialog', { name: 'Edit link' }).getByRole('textbox', { name: 'Note' }),
      ).toHaveValue('');
    },
  );
});
