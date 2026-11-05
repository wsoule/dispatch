'use client';

import { ChevronDown, Plus } from 'lucide-react';

import StatusMark from '../components/status-mark';
import { dataAttributes } from '../lib/data-attributes';
import type { UiStatus, UiTone } from '../types';
import { Button } from './button';
import { cx } from './class-names';
import styles from './section-header.module.css';
import type { SectionHeaderProps } from './types';

/* The status diamond's shape per tone (StatusMark's shapes, painted in the
   tone's hue by the module): danger the solid diamond (overdue, failed),
   warning the half-filled one (at risk, blocked), success the open one
   (on track), and the rest the open diamond in their own hue (info blue,
   muted grey, accent purple). */
const TONE_SHAPE: Record<Exclude<UiTone, 'default'>, UiStatus> = {
  danger: 'overdue',
  warning: 'at_risk',
  success: 'on_track',
  info: 'open',
  muted: 'open',
  accent: 'open',
};

/* Gr8r's group header, the one heading row over a band of rows (a board
   lane, a list group, a column of the Overseer): an optional fold chevron,
   a tone's status diamond and left edge, the host's icon, then one
   heading element holding the sentence-case name and its count (so the
   heading reads "Coming in 2"), and at the end the host's actions and a
   quiet "+". The parts carry data-part hooks (toggle, icon, name, count,
   actions); the host's data-* hooks land on the root. */
export function SectionHeader(props: SectionHeaderProps) {
  const {
    name,
    count,
    icon,
    tone,
    as: Heading = 'h3',
    collapsed = false,
    onToggle,
    toggleLabel,
    actions,
    onAdd,
    addLabel = 'New',
    rule = false,
    sticky = false,
    className,
  } = props;
  const toned = tone !== undefined && tone !== 'default' ? tone : undefined;
  const hasActions =
    (actions !== undefined && actions !== null && actions !== false) ||
    onAdd !== undefined;
  return (
    <div
      {...dataAttributes(props)}
      className={cx(
        styles.root,
        rule ? styles.rule : undefined,
        sticky ? styles.sticky : undefined,
        className
      )}
      data-tone={toned}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      {onToggle !== undefined ? (
        <Button
          variant="quiet"
          size="sm"
          className={styles.toggle}
          aria-label={
            toggleLabel ?? (collapsed ? 'Expand group' : 'Collapse group')
          }
          aria-expanded={!collapsed}
          onClick={() => onToggle()}
          data-part="toggle"
          icon={
            <ChevronDown
              className={styles.chevron}
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          }
        />
      ) : null}
      {toned !== undefined ? (
        // Decoration beside the words, which say the status: hidden from
        // assistive tech so the heading is not read twice.
        <span className={styles.toneMark} aria-hidden="true">
          <StatusMark status={TONE_SHAPE[toned]} label={toned} />
        </span>
      ) : null}
      {icon !== undefined && icon !== null ? (
        <span className={styles.icon} data-part="icon">
          {icon}
        </span>
      ) : null}
      <Heading className={styles.heading}>
        <span className={styles.name} data-part="name">
          {name}
        </span>
        {count !== undefined ? (
          <>
            {' '}
            <span className={styles.count} data-part="count">
              {count}
            </span>
          </>
        ) : null}
      </Heading>
      {hasActions ? (
        <span className={styles.actions} data-part="actions">
          {actions}
          {onAdd !== undefined ? (
            <Button
              variant="quiet"
              size="sm"
              aria-label={addLabel}
              title={addLabel}
              onClick={() => onAdd()}
              icon={<Plus size={14} strokeWidth={1.8} aria-hidden="true" />}
            />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
