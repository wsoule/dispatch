import { AlertStrip, Button, Link } from '@dispatch/ui';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';

import type { TimelineBanner } from '../../adapters/timeline';
import styles from './TimelineBanners.module.css';

// The Timeline's missing-input banners (the planner's timeline-banners.tsx,
// Better-Tracker): projects without a lead, milestones without a date and
// issues no milestone counts, as one Gr8r panel with a row per banner rather
// than a stack of tinted boxes. Each row is an AlertStrip in the banner's
// tone (every banner is a warning: a missing input) with its sentence and
// its follow-up link, and a quiet Show / Hide that expands the rows it
// counts. Every row's items link to their task through the shell's Link, so
// a click opens the task the way a sidebar project row does.

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

export interface TimelineBannersProps {
  banners: readonly TimelineBanner[];
}

/** Nothing at all when every banner is empty (the adapter leaves those out). */
export function TimelineBanners({ banners }: TimelineBannersProps) {
  if (banners.length === 0) return null;
  return (
    <section className={styles.panel} aria-label="Missing inputs">
      <ul className={styles.rows}>
        {banners.map((banner) => (
          <BannerRow key={banner.id} banner={banner} />
        ))}
      </ul>
    </section>
  );
}

function BannerRow({ banner }: { banner: TimelineBanner }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const noun = banner.items.length === 1 ? 'item' : 'items';
  return (
    <li className={styles.row} data-banner-id={banner.id}>
      <div className={styles.head}>
        <div className={styles.strip}>
          <AlertStrip
            label={banner.label}
            tone={banner.tone}
            plain
            action={banner.action}
          >
            {banner.text}
          </AlertStrip>
        </div>
        {banner.items.length > 0 ? (
          <Button
            size="sm"
            variant="quiet"
            iconAfter={
              <ChevronDown
                {...ICON}
                className={open ? styles.chevronOpen : undefined}
              />
            }
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Hide' : `Show ${banner.items.length} ${noun}`}
          </Button>
        ) : null}
      </div>
      <ul id={listId} className={styles.items} hidden={!open}>
        {banner.items.map((item) => (
          <li key={item.id} className={styles.item}>
            <Link href={item.href} className={styles.itemLink}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}
