import type { HastPlugin } from './satteriPlugin';

const NUMBERED = /^([0-9]+(?:\.[0-9]+)*|[A-F](?:\.[0-9]+)+) \S/;
const APPENDIX = /^Appendix ([A-F]) \S/;

export function sectionIdFor(text: string): string | null {
  const appendix = APPENDIX.exec(text);
  if (appendix !== null) return `s${appendix[1] ?? ''}`;
  const numbered = NUMBERED.exec(text);
  return numbered === null ? null : `s${numbered[1] ?? ''}`;
}

// Headings that start with a section number get the id s<number>, so §6.2 is
// #s6.2 without inline HTML anchors (MD033); Astro's slug ids keep it.
export function sectionIds(): HastPlugin {
  return {
    name: 'dmp-section-ids',
    element: {
      filter: ['h1', 'h2', 'h3', 'h4'],
      visit(node, ctx) {
        const id = sectionIdFor(ctx.textContent(node));
        if (id !== null) ctx.setProperty(node, 'id', id);
      },
    },
  };
}
