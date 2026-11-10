import type { CSSProperties, ReactNode } from 'react';

import { InitialsAvatar } from '../components/initials-avatar';
import StatusMark from '../components/status-mark';
import { PriorityGlyph, StateGlyph } from '../tasks/task-glyphs';
import styles from './picker-mark.module.css';
import { isHexColor } from './shared';
import type { PickerMark } from './types';

/* The leading mark of a picker option or trigger, drawn from the system's
   own glyphs: the state circle, the priority bars, the round avatar (a
   dashed empty circle for nobody), the milestone status diamond, a
   label's colour square or a host's node. Not a client module, so a
   read-only face renders on the server too. The marks are decorative (the
   label is always printed beside them) except the status diamond, which
   names its status. */
export interface PickerMarkViewProps {
  mark: PickerMark;
}

export function PickerMarkView({ mark }: PickerMarkViewProps): ReactNode {
  switch (mark.kind) {
    case 'state':
      return <StateGlyph kind={mark.state} size={14} />;
    case 'priority':
      return <PriorityGlyph priority={mark.priority} size={14} />;
    case 'avatar':
      // The package's one avatar (one hue per person everywhere). Nobody
      // (a blank name: "Unassigned", "Unassign") is its dashed empty
      // circle, as the list's unassigned cell draws it; never a "?".
      return <InitialsAvatar name={mark.name} />;
    case 'status':
      return (
        <StatusMark
          status={mark.status}
          label={mark.label}
          muted={mark.muted === true}
        />
      );
    case 'swatch': {
      // A colour from data is painted only here, and only when it is a
      // plain hex value; anything else draws the hollow square.
      const valid = isHexColor(mark.color);
      const style: CSSProperties | undefined = valid
        ? { backgroundColor: mark.color }
        : undefined;
      return (
        <span
          className={styles.swatch}
          style={style}
          aria-hidden="true"
          data-mark="swatch"
          data-empty={valid ? undefined : 'true'}
        />
      );
    }
    case 'node':
      return mark.node;
    default:
      return null;
  }
}
