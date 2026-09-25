// The /docs manifest: every page, its group, its order, and the title and
// description its <head> carries. The prose is `<slug>.mdx` beside this file.
//
// A TS module rather than a walk of this folder, for the reason app/sitemap.ts
// gives for its own hand-kept list: that module runs inside Next's build output,
// where the source tree is not where a relative path would look. An import
// resolves wherever it runs, so this one list feeds `generateStaticParams`, the
// sidebar, the prev/next links and the sitemap alike. `docs.spec.ts` beside it
// fails on a slug with no file and a file with no slug.
//
// Title and description live here rather than as frontmatter in the MDX because
// every consumer above needs them without compiling a page, and it spares the
// site a YAML parser.
//
// ORDER IS READING ORDER — the sidebar and prev/next follow it. A group earns its
// place when it has a page; there are no empty headings waiting for content (a
// placeholder prerenders as an indexable page, which is why the old /docs route
// was deleted until this one could ship with real pages).
//
// `description` is the meta description, so the same ~155-character budget as the
// one in app/layout.tsx: mechanism first, no call to action.

export type DocPage = { slug: string; title: string; description: string };
export type DocGroup = { title: string; pages: DocPage[] };

export const DOC_GROUPS: DocGroup[] = [
  {
    title: 'Get started',
    pages: [
      {
        slug: 'create-an-account',
        title: 'Create an account',
        description: 'Choose a username and password, save a recovery code, and understand what you need to sign in again.',
      },
      {
        slug: 'get-the-apps',
        title: 'Get the apps',
        description: 'Use the web app, phone apps, or Chrome and Firefox browser extension, and sign in on each device.',
      },
      {
        slug: 'save-links',
        title: 'Save links',
        description: 'Save a URL from the web app, phone apps, or browser extension, with a list, tags, and a note if you want.',
      },
    ],
  },
  {
    title: 'Organise',
    pages: [
      {
        slug: 'lists',
        title: 'Lists',
        description: 'Give each link a place, make and manage lists, and understand Archive, Trash, and nested folders.',
      },
      {
        slug: 'tags-and-notes',
        title: 'Tags and notes',
        description: 'Add several flat tags and a note to a link, and find out where each can be searched.',
      },
      {
        slug: 'search',
        title: 'Search your links',
        description: 'Search titles and addresses on your device, and use advanced fields to narrow results by note, list, or tag.',
      },
      {
        slug: 'select-and-bulk-edit',
        title: 'Select and edit several links',
        description: 'Select the links in a view, apply an action together, and understand the different actions in Trash.',
      },
      {
        slug: 'restore-a-link',
        title: 'Restore a link',
        description: 'Bring a removed link back from Trash, and understand what can and cannot be recovered after an edit or deletion.',
      },
    ],
  },
  {
    title: 'Previews',
    pages: [
      {
        slug: 'link-previews',
        title: 'Link previews',
        description: 'Learn where titles and images come from on each platform, what the optional server sees, and why a preview may fail.',
      },
    ],
  },
  {
    title: 'Your data',
    pages: [
      {
        slug: 'import',
        title: 'Import your links',
        description:
          'Bring links in from a browser, Raindrop.io, Pocket, LinkWarden, or a Bracemark backup: which file to use, what comes across, and what happens at your limit.',
      },
      {
        slug: 'export',
        title: 'Export your data',
        description:
          'Save your library as a Bracemark backup, an HTML bookmarks file, a CSV, or a list of URLs: what each one includes, and what every export leaves out.',
      },
      {
        slug: 'sign-out',
        title: 'Sign out',
        description: 'Remove this device’s local copy and session, sign out other devices, and let pending changes sync first.',
      },
    ],
  },
  {
    title: 'Account and security',
    pages: [
      {
        slug: 'lost-password',
        title: 'Lost your password',
        description:
          'Sign in with your recovery code and set a new password. How to replace a code you no longer trust, and what is left when both are gone.',
      },
      {
        slug: 'app-lock-and-list-locks',
        title: 'App and list locks',
        description: 'Set and open screen locks, use biometric unlock on a phone, and know what a forgotten lock password means.',
      },
      {
        slug: 'sync-and-devices',
        title: 'Sync and devices',
        description: 'See how offline changes reach your other devices, how to check sync, and what happens when two devices edit the same link.',
      },
    ],
  },
  {
    title: 'Plans',
    pages: [
      {
        slug: 'manage-your-subscription',
        title: 'Manage your subscription',
        description: 'Find your plan, manage billing in the store that sold it, restore a purchase, and understand what happens when it ends.',
      },
    ],
  },
  {
    title: 'Understand',
    pages: [
      {
        slug: 'what-a-saved-link-includes',
        title: 'What a saved link includes',
        description: 'See which details you add, which arrive from a preview, and what is available while your device is offline.',
      },
      {
        slug: 'sync-backup-and-export',
        title: 'Sync, backup, and export',
        description: 'Choose the right copy for work across devices, restoring missing links, or moving to another app.',
      },
      {
        slug: 'how-encryption-and-search-work',
        title: 'How encryption and search work',
        description: 'Follow a saved link from device to encrypted sync and understand why search runs locally.',
      },
    ],
  },
  {
    title: 'Compare',
    pages: [
      {
        slug: 'ways-to-keep-links',
        title: 'Ways to keep links',
        description: 'Compare browser bookmarks, local files, hosted managers, and encrypted sync by the jobs each one does.',
      },
    ],
  },
  {
    title: 'Move to Bracemark',
    pages: [
      {
        slug: 'import-from-chrome',
        title: 'Move from Chrome bookmarks',
        description: 'Export Chrome bookmarks as HTML, import the file, and check the resulting lists and links.',
      },
      {
        slug: 'import-from-firefox',
        title: 'Move from Firefox bookmarks',
        description: 'Export Firefox bookmarks as HTML on a computer, import the file, and check the result.',
      },
      {
        slug: 'import-from-raindrop',
        title: 'Move from Raindrop.io',
        description: 'Choose Raindrop.io’s HTML backup, import nested collections, and check which details come across.',
      },
      {
        slug: 'import-from-linkwarden',
        title: 'Move from Linkwarden',
        description: 'Import Linkwarden’s JSON backup with its collections, tags, notes, dates, and pins.',
      },
      {
        slug: 'import-from-karakeep',
        title: 'Move from Karakeep',
        description: 'Export Karakeep bookmarks as HTML, import the file, and check the lists and details that came across.',
      },
      {
        slug: 'import-from-pocket-export',
        title: 'Import an existing Pocket export',
        description: 'Bring in a Pocket ZIP or CSV you downloaded before its export window closed.',
      },
    ],
  },
];

export const DOC_PAGES: DocPage[] = DOC_GROUPS.flatMap((group) => group.pages);

export function findDoc(slug: string): { page: DocPage; group: DocGroup } | undefined {
  for (const group of DOC_GROUPS) {
    const page = group.pages.find((candidate) => candidate.slug === slug);
    if (page) return { page, group };
  }
  return undefined;
}

/** The pages either side of `slug` in reading order, across group boundaries. */
export function docNeighbours(slug: string): { prev?: DocPage; next?: DocPage } {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug);
  if (index === -1) return {};
  return { prev: DOC_PAGES[index - 1], next: DOC_PAGES[index + 1] };
}
