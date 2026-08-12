import { NativeSelect, NativeSelectOption } from '@/ui/native-select';

export type FineTuneCardControl =
  | {
      id: string;
      label: string;
      kind: 'segmented';
      options: string[];
      value: string;
    }
  | {
      id: string;
      label: string;
      kind: 'slider';
      min: number;
      max: number;
      value: number;
      unit?: string;
    }
  | {
      id: string;
      label: string;
      kind: 'select';
      options: string[];
      value: string;
    };

export type FineTuneCardProps = {
  title: string;
  controls: FineTuneCardControl[];
  onChange: (id: string, value: string | number) => void;
};

/** Mini toggle-group for the `segmented` control kind: a `bg-surface-inset`
 * track with the active option lifted onto `bg-card shadow-btn`, matching the
 * showcase's layout picker. */
function SegmentedControl({
  id,
  options,
  value,
  onChange,
}: {
  id: string;
  options: string[];
  value: string;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <div
      role="group"
      className="bg-surface-inset rounded-control flex items-center gap-0.5 p-0.5"
    >
      {options.map((option) => {
        const isActive = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(id, option)}
            className={`ease-out-expo rounded-chip px-2 py-1 text-[11.5px] font-medium capitalize transition-colors duration-150 motion-reduce:transition-none ${
              isActive
                ? 'bg-card text-foreground shadow-btn'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** Native range input for the `slider` control kind. The accent fill left of
 * the thumb is a gradient computed from the current value's position in
 * [min, max]; the thumb is styled to match the app's raised-chrome buttons. */
function SliderControl({
  id,
  min,
  max,
  value,
  unit,
  onChange,
}: {
  id: string;
  min: number;
  max: number;
  value: number;
  unit?: string;
  onChange: (id: string, value: number) => void;
}) {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <input
        type="range"
        aria-label={id}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(id, Number(event.target.value))}
        style={{
          backgroundImage: `linear-gradient(to right, var(--primary) ${String(percent)}%, var(--surface-inset) ${String(percent)}%)`,
        }}
        className="[&::-moz-range-thumb]:bg-card [&::-moz-range-thumb]:shadow-btn [&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow-btn h-1.5 w-20 flex-1 cursor-pointer appearance-none rounded-full outline-none [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full"
      />
      <span className="text-foreground w-8 shrink-0 text-right font-mono text-[11.5px] tabular-nums">
        {value}
        {unit ?? ''}
      </span>
    </div>
  );
}

/** Dropdown for the `select` control kind, reusing the shared native-select
 * chrome so it matches every other select in the app. */
function SelectControl({
  id,
  options,
  value,
  onChange,
}: {
  id: string;
  options: string[];
  value: string;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <NativeSelect
      size="sm"
      aria-label={id}
      value={value}
      onChange={(event) => onChange(id, event.target.value)}
      className="w-28 text-[12px] capitalize"
    >
      {options.map((option) => (
        <NativeSelectOption key={option} value={option} className="capitalize">
          {option}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function ControlRow({
  control,
  onChange,
}: {
  control: FineTuneCardControl;
  onChange: (id: string, value: string | number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground shrink-0 text-[12.5px] font-medium">
        {control.label}
      </span>
      {control.kind === 'segmented' && (
        <SegmentedControl
          id={control.id}
          options={control.options}
          value={control.value}
          onChange={onChange}
        />
      )}
      {control.kind === 'slider' && (
        <SliderControl
          id={control.id}
          min={control.min}
          max={control.max}
          value={control.value}
          unit={control.unit}
          onChange={onChange}
        />
      )}
      {control.kind === 'select' && (
        <SelectControl
          id={control.id}
          options={control.options}
          value={control.value}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/** Inspector card the agent uses to adjust design properties: a title bar and
 * a stack of rows, each pairing a muted label on the left with a control on
 * the right (segmented toggle-group, native range slider, or select).
 * Matches the showcase's "Fine-tune Card" primitive. Fully controlled — the
 * caller owns every control's value and receives updates via `onChange`. */
export function FineTuneCard({ title, controls, onChange }: FineTuneCardProps) {
  return (
    <div className="bg-card rounded-card shadow-raised w-full max-w-xs overflow-hidden">
      <div className="border-border flex items-center border-b px-4 py-2.5">
        <span className="text-foreground text-[13px] font-medium">{title}</span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {controls.map((control) => (
          <ControlRow key={control.id} control={control} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
