'use client';

// The table's column chooser (docs/link-layouts.md, _the table_): which columns
// show, and in what order. Rendered in three places, from this one component —
// under the Table radio in Settings → Appearance, in the links page's View options
// popover, and behind the table's own "+N hidden" header button — so they can't
// drift.
//
// The chosen columns come first, in their order, each with a Show checkbox, a
// drag grip, and Move up / Move down — the same drag-sort the Lists and Tags
// editors use (dnd-kit, a 5px activation distance so a click on the grip isn't a
// drag, and the sortable keyboard coordinates), and the same explicit buttons
// beside it, because a drag is no path at all for a keyboard or a screen reader
// (docs/accessibility.md). The columns not chosen follow, unchecked; checking one
// adds it at the end. The title isn't listed: it is always the first column.
//
// `onChange` takes the whole new order. The writer keeps any column entry a newer
// client wrote (mergeLayoutOptions).

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { TABLE_COLUMN_COPY } from '@stxapps/react';
import { arrayMove, TABLE_COLUMN_IDS, type TableColumnId } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Label } from '@stxapps/web-ui/components/ui/label';

import { DragGrip } from '@/app/(app)/settings/_components/table-kit';

function ChosenRow({
  id,
  idPrefix,
  isFirst,
  isLast,
  onHide,
  onMove,
}: {
  id: TableColumnId;
  idPrefix: string;
  isFirst: boolean;
  isLast: boolean;
  onHide: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const label = TABLE_COLUMN_COPY[id];
  const checkboxId = `${idPrefix}-column-${id}`;
  return (
    <li
      ref={setNodeRef}
      className={`flex min-h-11 items-center gap-2 ${isDragging ? 'opacity-50' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <DragGrip {...attributes} {...listeners} aria-label={`Drag ${label} to reorder`} />
      <Checkbox id={checkboxId} checked onCheckedChange={onHide} />
      <Label htmlFor={checkboxId} className="min-w-0 flex-1 font-normal">
        {label}
      </Label>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${label} up`}
        disabled={isFirst}
        onClick={() => onMove(-1)}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${label} down`}
        disabled={isLast}
        onClick={() => onMove(1)}
      >
        <ChevronDown className="size-4" />
      </Button>
    </li>
  );
}

export function TableColumnsChooser({
  columns,
  onChange,
  idPrefix,
}: {
  columns: readonly TableColumnId[];
  onChange: (columns: TableColumnId[]) => void;
  idPrefix: string;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const unchosen = TABLE_COLUMN_IDS.filter((id) => !columns.includes(id));

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = columns.indexOf(active.id as TableColumnId);
    const to = columns.indexOf(over.id as TableColumnId);
    if (from < 0 || to < 0) return;
    onChange(arrayMove([...columns], from, to));
  };

  return (
    <div className="flex flex-col">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={[...columns]} strategy={verticalListSortingStrategy}>
          <ul aria-label="Shown columns">
            {columns.map((id, index) => (
              <ChosenRow
                key={id}
                id={id}
                idPrefix={idPrefix}
                isFirst={index === 0}
                isLast={index === columns.length - 1}
                onHide={() => onChange(columns.filter((c) => c !== id))}
                onMove={(delta) => onChange(arrayMove([...columns], index, index + delta))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {unchosen.length > 0 && (
        <ul aria-label="Hidden columns">
          {unchosen.map((id) => {
            const checkboxId = `${idPrefix}-column-${id}`;
            return (
              // The grip's width (size-8 + gap-2) as padding, so the checkboxes line
              // up with the chosen rows' above.
              <li key={id} className="flex min-h-11 items-center gap-2 pl-10">
                <Checkbox
                  id={checkboxId}
                  checked={false}
                  onCheckedChange={() => onChange([...columns, id])}
                />
                <Label htmlFor={checkboxId} className="min-w-0 flex-1 font-normal">
                  {TABLE_COLUMN_COPY[id]}
                </Label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
