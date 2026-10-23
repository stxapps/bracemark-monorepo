import { type Locator, type Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { openNavigation } from './fixtures/layout';
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
import { grantPlusAndLoad } from './fixtures/plan';
import {
  createInSettings,
  lockListInSettings,
  nameField,
  renameInSettings,
  settingsOrder,
  settingsRow,
  unlockListInSettings,
} from './fixtures/taxonomy';

// Lists and tags across the surfaces that read them. What no component spec can
// see is the live store between them: a settings table writes an entity, and a
// picker, a sidebar or a filtered read on ANOTHER mounted surface has to agree —
// through Dexie's cross-tab observation, a real reload, and the lock coverage
// folded into the read edge (docs/editors.md, docs/locks.md). The tree maths,
// the projection and the coverage walk keep their unit specs.

// Pick an EXISTING entity in an open picker by typing its name. The exact-match
// rule suppresses the Create row (docs/editors.md, _two smaller consequences_),
// so a Create row appearing here would mean the picker did not see the entity.
async function pickExistingList(scope: Page | Locator, page: Page, name: string) {
  const combobox = scope.getByRole('combobox', { name: 'List' });
  await combobox.click();
  await page.getByPlaceholder('Search or create lists…').fill(name);
  await expect(page.getByRole('option', { name: `Create “${name}”` })).toHaveCount(0);
  await page.getByRole('option', { name, exact: true }).click();
  await expect(combobox).toContainText(name);
}

async function pickExistingTag(scope: Page | Locator, page: Page, name: string) {
  await scope.getByRole('combobox', { name: 'Tags' }).click();
  await page.getByPlaceholder('Search or create tags…').fill(name);
  await expect(page.getByRole('option', { name: `Create “${name}”` })).toHaveCount(0);
  await page.getByRole('option', { name, exact: true }).click();
  await expect(scope.getByRole('button', { name: `Remove ${name}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Search or create tags…')).toHaveCount(0);
}

// Quick-add a link into an existing list, optionally with an existing tag.
async function addLinkInto(page: Page, url: string, list: string, tag?: string) {
  await addLinkButton(page).click();
  await page.locator('#link-url').fill(url);
  await page.getByRole('button', { name: 'List, tags & note' }).click();
  await pickExistingList(page, page, list);
  if (tag) await pickExistingTag(page, page, tag);
  await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
  await expect(page.locator('#link-url')).toHaveCount(0);
}

// Drag one settings row by its grip with a real pointer, into the SLOT another
// row holds — dnd-kit moves the dragged row to `over`'s index and shifts the rest,
// which is why "land after A" means dropping on the row after A. PointerSensor
// needs 5px of travel before a drag starts, and closestCenter resolves `over`
// from the dragged rect's centre, so the move goes in small steps to the upper
// part of the target row. The horizontal offset drives the projected depth (20px
// per level — INDENT_WIDTH in the section's dnd-helpers).
async function dragRow(page: Page, from: Locator, to: Locator, offsetX = 0) {
  const grip = from.getByRole('button', { name: 'Drag to reorder' });
  const start = await grip.boundingBox();
  const target = await to.boundingBox();
  if (!start || !target) throw new Error('drag rows are not laid out');
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + (target.y > start.y ? 8 : -8), { steps: 4 });
  await page.mouse.move(x + offsetX, target.y + target.height * 0.25, { steps: 20 });
  await page.mouse.up();
}

test.describe('lists, tags and filters', () => {
  test(
    'a list and a tag created and renamed in settings are live in an open editor’s pickers',
    { tag: ['@TAXONOMY-EDITOR-001', '@full', '@online'] },
    async ({ app, page }) => {
      const list = unique('E2e picker list');
      const renamedList = unique('E2e renamed list');
      const tag = unique('e2e-picker-tag');
      const renamedTag = unique('e2e-renamed-tag');
      const url = unresolvableUrl(unique('picker'));

      // The editor is OPEN, with its list picker open, before settings writes
      // anything, and nothing here reloads it: the create and the rename have to
      // reach a picker that was already reading the taxonomy, through Dexie's
      // cross-tab observation.
      await page.goto('/links');
      await addLinkButton(page).click();
      await page.locator('#link-url').fill(url);
      await page.getByRole('button', { name: 'List, tags & note' }).click();
      const listPicker = page.getByRole('combobox', { name: 'List' });
      await listPicker.click();
      const listSearch = page.getByPlaceholder('Search or create lists…');
      await expect(listSearch).toBeVisible();

      const settings = await app.context.newPage();
      try {
        await createInSettings(settings, 'list', list);
        await renameInSettings(settings, 'list', list, renamedList);
        await createInSettings(settings, 'tag', tag);
        await renameInSettings(settings, 'tag', tag, renamedTag);
      } finally {
        await settings.close();
      }

      // The old name is gone from the still-open picker — typing it offers only
      // Create — and the new one is a row.
      await listSearch.fill(list);
      await expect(page.getByRole('option', { name: `Create “${list}”` })).toBeVisible();
      await expect(page.getByRole('option', { name: list, exact: true })).toHaveCount(0);
      await listSearch.fill(renamedList);
      await expect(page.getByRole('option', { name: `Create “${renamedList}”` })).toHaveCount(0);
      await page.getByRole('option', { name: renamedList, exact: true }).click();
      await expect(listPicker).toContainText(renamedList);

      await page.getByRole('combobox', { name: 'Tags' }).click();
      const tagSearch = page.getByPlaceholder('Search or create tags…');
      await tagSearch.fill(tag);
      await expect(page.getByRole('option', { name: `Create “${tag}”` })).toBeVisible();
      await expect(page.getByRole('option', { name: tag, exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await pickExistingTag(page, page, renamedTag);
      await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
      await expect(page.locator('#link-url')).toHaveCount(0);

      // Filed under the renamed entities, as the sidebar reads them.
      await openSidebarItem(page, renamedList);
      await expect(linkRow(page, url)).toHaveCount(1);
      await expect(linkRow(page, url)).toContainText(renamedTag);
      await openSidebarItem(page, renamedTag);
      await expect(linkRow(page, url)).toHaveCount(1);
    },
  );

  test(
    'a sibling reorder and a reparent by pointer drag survive a reload',
    { tag: ['@TAXONOMY-DND-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // Its own account on Plus: the reparent lands a nested list, the
      // `nestedLists` lever, and a free drop routes to the paywall instead.
      const { page, credentials } = app;
      await grantPlusAndLoad(page, credentials.username);

      const a = unique('E2e dnd A');
      const b = unique('E2e dnd B');
      const c = unique('E2e dnd C');
      // Each create lands at the top of the root group, so the table reads C, B, A.
      for (const name of [a, b, c]) await createInSettings(page, 'list', name);
      expect((await settingsOrder(page, 'list')).slice(0, 3)).toEqual([c, b, a]);

      // --- sibling reorder: A from third to first -------------------------------
      await dragRow(page, settingsRow(page, 'list', a), settingsRow(page, 'list', c));
      await expect
        .poll(async () => (await settingsOrder(page, 'list')).slice(0, 3))
        .toEqual([a, c, b]);

      // --- reparent: B into C's slot, right after A, one indent to the right -----
      await dragRow(page, settingsRow(page, 'list', b), settingsRow(page, 'list', c), 30);
      await expect(
        settingsRow(page, 'list', a).getByRole('button', { name: 'Collapse' }),
      ).toBeVisible();

      // --- after a reload: the order, and the tree ------------------------------
      await page.reload();
      await expect(nameField(page, 'list', a)).toBeVisible();
      expect((await settingsOrder(page, 'list')).slice(0, 3)).toEqual([a, b, c]);
      // B is A's child, not merely its neighbour: collapsing A takes B with it
      // and leaves C.
      await settingsRow(page, 'list', a).getByRole('button', { name: 'Collapse' }).click();
      await expect(nameField(page, 'list', b)).toHaveCount(0);
      await expect(nameField(page, 'list', c)).toBeVisible();

      // The links rail reads the same tree: B sits under A's disclosure. Narrow,
      // the rail is the drawer, which a disclosure toggle leaves open.
      await page.goto('/links');
      const rail = await openNavigation(page);
      await expect(rail.getByRole('button', { name: b, exact: true })).toBeVisible();
      // The row's own wrapper: the innermost div holding A's nav button, which
      // also holds A's disclosure toggle.
      const parent = rail
        .locator('div')
        .filter({ has: page.getByRole('button', { name: a, exact: true }) })
        .last();
      await parent.getByRole('button', { name: 'Collapse' }).click();
      await expect(rail.getByRole('button', { name: b, exact: true })).toHaveCount(0);
      await expect(rail.getByRole('button', { name: c, exact: true })).toBeVisible();
    },
  );

  test(
    'each filtered view holds its member and not its non-member',
    { tag: ['@FILTER-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // Its own account, so Show All is short enough that every row asserted on
      // is rendered rather than virtualized away.
      const { page } = app;
      const list = unique('E2e filter list');
      const tag = unique('e2e-filter-tag');
      const filed = unresolvableUrl(unique('filter-filed'));
      const inbox = unresolvableUrl(unique('filter-inbox'));
      const archived = unresolvableUrl(unique('filter-archived'));
      const trashed = unresolvableUrl(unique('filter-trashed'));

      await page.goto('/links');
      await addLinkButton(page).click();
      await page.locator('#link-url').fill(filed);
      await page.getByRole('button', { name: 'List, tags & note' }).click();
      await createListInPicker(page, page, list);
      await createTagInPicker(page, page, tag);
      await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
      await expect(page.locator('#link-url')).toHaveCount(0);

      await addLink(page, inbox);
      await addLink(page, archived);
      await chooseRowMenuItem(page, archived, 'Archive');
      await addLink(page, trashed);
      await chooseRowMenuItem(page, trashed, 'Remove');

      const views: Array<{ view: string; member: string; nonMember: string; url: RegExp }> = [
        { view: list, member: filed, nonMember: inbox, url: /[?&]list=/ },
        { view: tag, member: filed, nonMember: inbox, url: /[?&]tag=/ },
        // Show All carries Archive and suppresses Trash (use-links.ts).
        { view: 'Show All', member: archived, nonMember: trashed, url: /[?&]list=all/ },
        { view: 'Archive', member: archived, nonMember: inbox, url: /[?&]list=archive/ },
        { view: 'Trash', member: trashed, nonMember: archived, url: /[?&]list=trash/ },
      ];
      for (const { view, member, nonMember, url } of views) {
        await openSidebarItem(page, view);
        await expect(page).toHaveURL(url);
        await expect(linkRow(page, member)).toHaveCount(1);
        await expect(linkRow(page, nonMember)).toHaveCount(0);
      }
    },
  );

  test(
    'hidden and locked lists stay editor destinations while their links stay unread',
    { tag: ['@FILTER-HIDDEN-LOCKED-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      await grantPlusAndLoad(page, credentials.username);

      const hidden = unique('E2e hidden list');
      const locked = unique('E2e locked list');
      const tag = unique('e2e-locked-tag');
      const word = unique('lockword').toLowerCase();
      const inHidden = unresolvableUrl(`${word}-in-hidden`);
      const inLocked = unresolvableUrl(`${word}-in-locked`);
      const filedLater = unresolvableUrl(`${word}-filed-while-locked`);
      const movedLater = unresolvableUrl(`${word}-moved-while-locked`);
      const password = unique('list-lock-password');

      await createInSettings(page, 'list', hidden);
      await createInSettings(page, 'list', locked);
      await createInSettings(page, 'tag', tag);
      await page.goto('/links');
      await addLinkInto(page, inHidden, hidden, tag);
      await addLinkInto(page, inLocked, locked, tag);
      await addLink(page, movedLater);

      await lockListInSettings(page, hidden, password, { hide: true });
      await lockListInSettings(page, locked, password);

      // --- unauthorized reads ---------------------------------------------------
      await page.goto('/links');
      const rail = page.getByRole('complementary');
      await expect(linkRow(page, movedLater)).toHaveCount(1);
      await expect(rail.getByRole('button', { name: new RegExp(`^${hidden}`) })).toHaveCount(0);
      // A locked row's name carries its badge.
      await openSidebarItem(page, `${locked} Locked`);
      await expect(page.getByRole('heading', { name: 'This list is locked' })).toBeVisible();

      const readsOf = [
        async () => openSidebarItem(page, 'Show All'),
        async () => openSidebarItem(page, tag),
        async () => {
          await page.getByRole('textbox', { name: 'Search links' }).fill(word);
          await page.keyboard.press('Enter');
          await expect(page).toHaveURL(new RegExp(`[?&]text=${word}`));
          // The positive control for this view: the unlocked link with the word.
          await expect(linkRow(page, movedLater)).toHaveCount(1);
        },
      ];
      for (const read of readsOf) {
        await read();
        await expect(page.locator('main')).not.toContainText(displayUrl(inHidden));
        await expect(page.locator('main')).not.toContainText(displayUrl(inLocked));
        // Not merely hidden: absent from the document a screen reader or
        // find-in-page would walk.
        const html = await page.content();
        expect(html).not.toContain(inHidden);
        expect(html).not.toContain(inLocked);
      }

      // --- still destinations ---------------------------------------------------
      await page.goto('/links');
      await addLinkInto(page, filedLater, hidden);
      await chooseRowMenuItem(page, movedLater, 'Edit');
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await pickExistingList(dialog, page, locked);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // Both writes landed inside locked lists, so neither is readable now.
      await expect(linkRow(page, movedLater)).toHaveCount(0);
      await openSidebarItem(page, 'Show All');
      await expect(linkRow(page, filedLater)).toHaveCount(0);
      await expect(linkRow(page, movedLater)).toHaveCount(0);

      // --- and the writes are really there once unlocked ------------------------
      // Unlocked state is in-memory until the next load (docs/locks.md), so the
      // way back is the settings ✕ — a client-side navigation — not a `goto`.
      await unlockListInSettings(page, hidden, password);
      await page.getByRole('link', { name: 'Close settings' }).click();
      await expect(addLinkButton(page)).toBeVisible();
      await openSidebarItem(page, hidden);
      await expect(linkRow(page, inHidden)).toHaveCount(1);
      await expect(linkRow(page, filedLater)).toHaveCount(1);

      await openSidebarItem(page, `${locked} Locked`);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(linkRow(page, inLocked)).toHaveCount(1);
      await expect(linkRow(page, movedLater)).toHaveCount(1);
    },
  );
});
