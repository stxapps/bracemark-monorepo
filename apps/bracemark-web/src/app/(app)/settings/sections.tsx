// The settings sections, defined once and shared by the sidebar (renders them as
// the nav rail), the topbar/main (name + render the active one). One source of
// truth keeps the menu, the labels, and the content switch from drifting apart.

import {
  CreditCard,
  Database,
  Folders,
  Info,
  Link,
  SlidersHorizontal,
  Tags,
  User,
} from 'lucide-react';

export type SettingsSectionId =
  'account' | 'subscription' | 'data' | 'extraction' | 'lists' | 'tags' | 'misc' | 'about';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: React.ReactNode;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'account', label: 'Account', icon: <User className="size-4" /> },
  { id: 'subscription', label: 'Subscription', icon: <CreditCard className="size-4" /> },
  { id: 'data', label: 'Data', icon: <Database className="size-4" /> },
  { id: 'extraction', label: 'Link Previews', icon: <Link className="size-4" /> },
  { id: 'lists', label: 'Lists', icon: <Folders className="size-4" /> },
  { id: 'tags', label: 'Tags', icon: <Tags className="size-4" /> },
  { id: 'misc', label: 'Misc.', icon: <SlidersHorizontal className="size-4" /> },
  { id: 'about', label: 'About', icon: <Info className="size-4" /> },
];

export const DEFAULT_SECTION_ID: SettingsSectionId = 'account';

// The section ids as a flat list, plus a guard for validating the `[section]`
// route param (the path is user-supplied — anything not in here 404s).
export const SETTINGS_SECTION_IDS: SettingsSectionId[] = SETTINGS_SECTIONS.map((s) => s.id);

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as string[]).includes(value);
}
