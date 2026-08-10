'use client';

// Full-height left rail for the settings page: the brand lockup, then the section
// menu (Account, Subscription, Lists, Tags, Misc., About). Each entry is a link to
// `/settings/[section]`; the active one is derived from the pathname (the URL is
// the source of truth), and the matching section page renders the content.
//
// HIDDEN BELOW `md`, where the topbar's section menu replaces it — a 15rem rail
// on a 390px screen left the content column about 130px wide, which wrapped every
// description to one word per line. The two are the same nav rendered for the
// space available, so they read the same list in the same order.
//
// The lockup replaced a bare back arrow that was pinned to the rail's top-RIGHT
// corner, anchored to nothing and duplicating the topbar's close button. The rail
// now says which app this is, matching the browser extension's options page
// exactly (mark at `h-5`, wordmark at `text-[0.9375rem] font-semibold
// tracking-tight`, `gap-2.5`) — the two settings surfaces should be
// indistinguishable, and its header sits at the same `h-14` as the topbar so the
// two hairlines meet across the frame. Leaving the surface is the topbar's job,
// in one place, where a close control is looked for.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { cn } from '@stxapps/web-ui/lib/utils';

import { SETTINGS_SECTIONS, type SettingsSection } from '../sections';

function NavItem({ section }: { section: SettingsSection }) {
  const pathname = usePathname();
  const href = `/settings/${section.id}`;
  const active = pathname === href;

  return (
    <Link
      href={href}
      // `page`, not `true`: this is a link to the location currently shown, which
      // is the one value assistive tech announces as "current page".
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
        'hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className={cn('flex size-4 shrink-0 items-center justify-center')}>{section.icon}</span>
      <span className={cn('truncate')}>{section.label}</span>
    </Link>
  );
}

export function Sidebar() {
  return (
    <aside className={cn('hidden h-full w-60 shrink-0 flex-col border-r border-border md:flex')}>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4')}>
        <BracemarkIcon className={cn('h-5 w-auto shrink-0')} aria-hidden="true" />
        <span className={cn('text-[0.9375rem] leading-none font-semibold tracking-tight')}>
          Bracemark
        </span>
      </div>

      <nav
        aria-label="Settings sections"
        className={cn('flex flex-1 flex-col gap-0.5 overflow-y-auto p-2')}
      >
        {SETTINGS_SECTIONS.map((section) => (
          <NavItem key={section.id} section={section} />
        ))}
      </nav>
    </aside>
  );
}
