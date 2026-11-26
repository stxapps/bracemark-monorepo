// The display options for ONE layout (card or list) — the expo port of
// bracemark-web's `components/layout-options-controls.tsx` (the canonical doc:
// one component for Settings → Appearance and the links screen's View options
// sheet, source-agnostic, and `onChange` takes a PATCH the writers merge over
// the stored options). Same rows, same order, same words.
//
// RN divergences: a choice is a DropdownMenu radio group behind an outline
// button (web's Select), and a toggle is the platform Switch, which carries the
// 44pt target and the OS announcements itself (components/ui/switch.tsx). Every
// row is at least 44pt tall (`min-h-11`), so neighbouring targets never overlap
// (docs/accessibility.md).

import { Fragment } from 'react';
import { View } from 'react-native';
import { ChevronDown } from 'lucide-react-native';

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

import { EXPO_TAG_LINES_SUPPORTED } from '../lib/tag-lines';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

// The toggles, in display order — web's, verbatim.
const TOGGLES: Record<OptionLayout, (keyof LinkFields)[]> = {
  card: ['listName', 'tags', 'note', 'keptCopy'],
  list: ['image', 'listName', 'tags', 'note', 'keptCopy'],
};

const TITLE_LINE_VALUES = TITLE_LINE_COUNTS.map(String);
const TAG_LINE_VALUES = TAG_LINE_COUNTS.map(String);
const CARD_IMAGE_VALUES: readonly (CardImageHeight | 'off')[] = ['off', ...CARD_IMAGE_HEIGHTS];

export function ChoiceRow<T extends string>({
  testID,
  label,
  value,
  values,
  copy,
  onChange,
}: {
  testID: string;
  label: string;
  value: T;
  values: readonly T[];
  copy: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-4">
      <Text className="min-w-0 flex-1">{label}</Text>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* `shrink-0`: the label beside it gives way instead. Left to shrink (RN's
              Button does), the trigger clipped its own value to "Car" / "Sm" at the
              1.3 text-size cap — break-ui, the Pixel 8 AVD. */}
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            testID={testID}
            aria-label={`${label}: ${copy(value)}`}
          >
            <Text>{copy(value)}</Text>
            <Icon as={ChevronDown} className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {values.map((v) => (
              <DropdownMenuRadioItem key={v} value={v} testID={`${testID}-${v}`}>
                <Text>{copy(v)}</Text>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function ToggleRow({
  testID,
  label,
  checked,
  onChange,
}: {
  testID: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-4">
      <Text className="min-w-0 flex-1">{label}</Text>
      <Switch testID={testID} accessibilityLabel={label} value={checked} onValueChange={onChange} />
    </View>
  );
}

export function LayoutOptionsControls({
  layout,
  options,
  onChange,
  testIDPrefix,
}: {
  layout: OptionLayout;
  options: LayoutOptions;
  onChange: (patch: LayoutOptionsPatch) => void;
  testIDPrefix: string;
}) {
  const own = options[layout];
  const testID = (name: string) => `${testIDPrefix}-${layout}-${name}`;
  const patch = (p: NonNullable<LayoutOptionsPatch[OptionLayout]>) => onChange({ [layout]: p });
  const setField = <K extends keyof LinkFields>(key: K, value: LinkFields[K]) =>
    patch({ fields: { [key]: value } });

  return (
    <View>
      {layout === 'card' && (
        <>
          <ChoiceRow<CardSize>
            testID={testID('size')}
            label={CARD_SIZE_COPY.label}
            value={options.card.size}
            values={CARD_SIZES}
            copy={(v) => CARD_SIZE_OPTION_COPY[v]}
            onChange={(size) => patch({ size })}
          />
          <ChoiceRow<CardImageHeight | 'off'>
            testID={testID('image')}
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
        testID={testID('title-lines')}
        label={TITLE_LINES_COPY.label}
        value={String(own.titleLines)}
        values={TITLE_LINE_VALUES}
        copy={String}
        onChange={(v) => patch({ titleLines: Number(v) as TitleLines })}
      />
      <ChoiceRow<AddressMode>
        testID={testID('address')}
        label={LINK_FIELD_COPY.address}
        value={own.fields.address}
        values={ADDRESS_MODES}
        copy={(v) => ADDRESS_MODE_COPY[v]}
        onChange={(v) => setField('address', v)}
      />
      <ChoiceRow<DateMode>
        testID={testID('date')}
        label={LINK_FIELD_COPY.date}
        value={own.fields.date}
        values={DATE_MODES}
        copy={(v) => DATE_MODE_COPY[v]}
        onChange={(v) => setField('date', v)}
      />
      {TOGGLES[layout].map((key) => (
        <Fragment key={key}>
          <ToggleRow
            testID={testID(key)}
            label={LINK_FIELD_COPY[key]}
            checked={own.fields[key] as boolean}
            onChange={(checked) => setField(key, checked)}
          />
          {key === 'tags' && own.fields.tags && EXPO_TAG_LINES_SUPPORTED && (
            <ChoiceRow<string>
              testID={testID('tag-lines')}
              label={TAG_LINES_COPY.label}
              value={String(own.tagLines)}
              values={TAG_LINE_VALUES}
              copy={String}
              onChange={(v) => patch({ tagLines: Number(v) as TagLines })}
            />
          )}
        </Fragment>
      ))}
    </View>
  );
}
