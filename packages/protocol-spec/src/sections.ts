import { readdirSync, readFileSync } from 'node:fs';

export const SECTION_NUMBER =
  /^#{1,4} ([0-9]+(?:\.[0-9]+)*|[A-F](?:\.[0-9]+)+) \S/;
export const APPENDIX_HEADING = /^# Appendix ([A-F]) \S/;
export const SPEC_DIR = new URL('../spec/', import.meta.url);
// A code fence line (CommonMark): its marker run, then the rest of the line.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;

// Section numbers a markdown file declares outside fenced code, in document
// order; vectors, registries and the site's anchors all key on these.
export function sectionsOf(markdown: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line);
    const run = marker?.[1] ?? '';
    if (fence !== '') {
      // Only a bare run of the opening character, at least as long, closes it.
      const bare = (marker?.[2] ?? '').trim() === '';
      if (run.startsWith(fence.charAt(0)) && run.length >= fence.length && bare)
        fence = '';
      continue;
    }
    if (run !== '') {
      fence = run;
      continue;
    }
    const appendix = APPENDIX_HEADING.exec(line);
    const numbered = SECTION_NUMBER.exec(line);
    if (appendix !== null) out.push(appendix[1] ?? '');
    else if (numbered !== null) out.push(numbered[1] ?? '');
  }
  return out;
}

// Every section number the spec declares, reading its files in name order.
export function listSections(specDir: URL): string[] {
  return readdirSync(specDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort()
    .flatMap((f) => sectionsOf(readFileSync(new URL(f, specDir), 'utf8')));
}
