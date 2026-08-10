// The settings sections, defined once and shared by the sidebar (renders them
// as the drawer's nav rail), the topbar (names the active one), and the
// [section] route (renders + validates). The expo port of bracemark-web's
// `(app)/settings/sections.tsx` — one source of truth keeps the menu, the
// labels, and the content switch from drifting apart. One divergence: icons are
// `LucideIcon` components (rendered through the ui `Icon` wrapper), not JSX, so
// this stays a .ts file.
//
// `extraction` IS here, and means something different than it does on web: web's
// section governs SERVER extraction (a paid Plus path through bracemark-extractor),
// while this one governs ON-DEVICE extraction — the app fetching pages itself,
// free on every plan, with the toggle gating only the un-gestured residual
// (links that arrived by sync or import). See docs/link-extraction.md — _expo
// drains in the foreground_ — and extraction-section.tsx for what that changes
// in the surface.

import {
  CreditCard,
  Database,
  Folders,
  Info,
  Link,
  type LucideIcon,
  SlidersHorizontal,
  Tags,
  User,
} from 'lucide-react-native';

export type SettingsSectionId =
  'account' | 'subscription' | 'data' | 'extraction' | 'lists' | 'tags' | 'misc' | 'about';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'subscription', label: 'Subscription', icon: CreditCard },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'extraction', label: 'Link previews', icon: Link },
  { id: 'lists', label: 'Lists', icon: Folders },
  { id: 'tags', label: 'Tags', icon: Tags },
  { id: 'misc', label: 'Misc.', icon: SlidersHorizontal },
  { id: 'about', label: 'About', icon: Info },
];

export const DEFAULT_SECTION_ID: SettingsSectionId = 'account';

// The section ids as a flat list, plus a guard for validating the `[section]`
// route param (the path is user-supplied — anything not in here 404s).
export const SETTINGS_SECTION_IDS: SettingsSectionId[] = SETTINGS_SECTIONS.map((s) => s.id);

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as string[]).includes(value);
}
