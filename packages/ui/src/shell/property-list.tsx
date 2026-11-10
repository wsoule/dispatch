import type { ReactNode } from 'react';

import styles from './property-list.module.css';
import { renderIcon } from './render';
import type { PropertyListProps } from './types';

/* Gr8r's drawer property sheet (.kv): sentence-case labels with their
   icons in a 112px column, values beside them, 30px rows and no rules. */
export default function PropertyList({
  items,
  label,
}: PropertyListProps): ReactNode {
  return (
    <dl className={styles.list} aria-label={label}>
      {items.map((item) => (
        <div key={item.id ?? item.label} className={styles.row}>
          <dt className={styles.term}>
            {item.icon !== undefined ? (
              <span className={styles.icon}>{renderIcon(item.icon)}</span>
            ) : null}
            {item.label}
          </dt>
          <dd className={styles.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
