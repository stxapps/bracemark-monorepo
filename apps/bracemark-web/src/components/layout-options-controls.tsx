'use client';

// The display options for ONE layout (card or list) — the controls under the
// layout radios in Settings → Appearance and in the links page's View options
// popover. One component, so the two surfaces can't drift on which options a
// layout has, their order, or their words (docs/link-layouts.md, _the options_).
//
// Source-agnostic like the settings radios: the caller binds `options` and
// `onChange` to the synced pack, the device pack, or the active one. `onChange`
// takes a PATCH (LayoutOptionsPatch) for just this layout — the writers merge it
// over the stored options, so an option a newer client wrote survives.
//
// Compact rows rather than the hinted option cards above them: a label on the
// left, a Select or a Switch on the right. Each row is at least 44px tall
// (`min-h-11`) because the Switch's invisible hit area reaches 13px above and below
// its 20px track (web-ui switch.tsx) — rows any closer and two switches' targets
// overlap, so a tap meant for one toggles its neighbour (docs/accessibility.md).

import { Fragment } from 'react';

import {
  ADDRESS_MODE_COPY,
  CARD_IMAGE_COPY,
  CARD_IMAGE_OPTION_COPY,
  CARD_SIZE_COPY,
  CARD_SIZE_OPTION_COPY,
  DATE_MODE_COPY,
  LINK_FIELD_COPY,
  TAG_LINES_COPY,
  TITLE_LINES_COPY,
} from '@stxapps/react';
import {
  ADDRESS_MODES,
  type AddressMode,
  CARD_IMAGE_HEIGHTS,
  CARD_SIZES,
  type CardImageHeight,
  type CardSize,
  DATE_MODES,
  type DateMode,
  type LayoutOptions,
  type LayoutOptionsPatch,
  type LinkFields,
  type OptionLayout,
  TAG_LINE_COUNTS,
  type TagLines,
  TITLE_LINE_COUNTS,
  type TitleLines,
} from '@stxapps/shared';
import { Label } from '@stxapps/web-ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stxapps/web-ui/components/ui/select';
import { Switch } from '@stxapps/web-ui/components/ui/switch';

// The toggles, in display order. `image` is a toggle on the list only — the card's
// image is part of the Off / Short / Medium / Tall choice above them.
const TOGGLES: Record<OptionLayout, (keyof LinkFields)[]> = {
  card: ['listName', 'tags', 'note', 'keptCopy'],
  list: ['image', 'listName', 'tags', 'note', 'keptCopy'],
};

const TITLE_LINE_VALUES = TITLE_LINE_COUNTS.map(String);
const TAG_LINE_VALUES = TAG_LINE_COUNTS.map(String);
const CARD_IMAGE_VALUES: readonly (CardImageHeight | 'off')[] = ['off', ...CARD_IMAGE_HEIGHTS];

export function ChoiceRow<T extends string>({
  id,
  label,
  value,
  values,
  copy,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  values: readonly T[];
  copy: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger id={id} size="sm" className="min-w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {values.map((v) => (
            <SelectItem key={v} value={v}>
              {copy(v)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function LayoutOptionsControls({
  layout,
  options,
  onChange,
  idPrefix,
}: {
  layout: OptionLayout;
  options: LayoutOptions;
  onChange: (patch: LayoutOptionsPatch) => void;
  // Keeps the ids unique when two sets can render at once.
  idPrefix: string;
}) {
  const own = options[layout];
  const id = (name: string) => `${idPrefix}-${layout}-${name}`;
  const patch = (p: NonNullable<LayoutOptionsPatch[OptionLayout]>) => onChange({ [layout]: p });
  const setField = <K extends keyof LinkFields>(key: K, value: LinkFields[K]) =>
    patch({ fields: { [key]: value } });

  return (
    <div className="flex flex-col">
      {layout === 'card' && (
        <>
          <ChoiceRow<CardSize>
            id={id('size')}
            label={CARD_SIZE_COPY.label}
            value={options.card.size}
            values={CARD_SIZES}
            copy={(v) => CARD_SIZE_OPTION_COPY[v]}
            onChange={(size) => patch({ size })}
          />
          <ChoiceRow<CardImageHeight | 'off'>
            id={id('image')}
            label={CARD_IMAGE_COPY.label}
            value={options.card.fields.image ? options.card.imageHeight : 'off'}
            values={CARD_IMAGE_VALUES}
            copy={(v) => CARD_IMAGE_OPTION_COPY[v]}
            // Off keeps the stored height, so turning the image back on brings it back.
            onChange={(v) =>
              patch(
                v === 'off'
                  ? { fields: { image: false } }
                  : { imageHeight: v, fields: { image: true } },
              )
            }
          />
        </>
      )}
      <ChoiceRow<string>
        id={id('title-lines')}
        label={TITLE_LINES_COPY.label}
        value={String(own.titleLines)}
        values={TITLE_LINE_VALUES}
        copy={String}
        onChange={(v) => patch({ titleLines: Number(v) as TitleLines })}
      />
      <ChoiceRow<AddressMode>
        id={id('address')}
        label={LINK_FIELD_COPY.address}
        value={own.fields.address}
        values={ADDRESS_MODES}
        copy={(v) => ADDRESS_MODE_COPY[v]}
        onChange={(v) => setField('address', v)}
      />
      <ChoiceRow<DateMode>
        id={id('date')}
        label={LINK_FIELD_COPY.date}
        value={own.fields.date}
        values={DATE_MODES}
        copy={(v) => DATE_MODE_COPY[v]}
        onChange={(v) => setField('date', v)}
      />
      {TOGGLES[layout].map((key) => (
        <Fragment key={key}>
          <ToggleRow
            id={id(key)}
            label={LINK_FIELD_COPY[key]}
            checked={own.fields[key] as boolean}
            onChange={(checked) => setField(key, checked)}
          />
          {/* Right under the toggle it depends on, and only while tags show. */}
          {key === 'tags' && own.fields.tags && (
            <ChoiceRow<string>
              id={id('tag-lines')}
              label={TAG_LINES_COPY.label}
              value={String(own.tagLines)}
              values={TAG_LINE_VALUES}
              copy={String}
              onChange={(v) => patch({ tagLines: Number(v) as TagLines })}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
