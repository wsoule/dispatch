import { describe, it, expect } from 'vitest';
import { appendActivity } from '../src/taskfile.js';

describe('appendActivity', () => {
  it('appends a bullet to an existing Activity section', () => {
    const body = '\n## Description\n\nX\n\n## Activity\n';
    const out = appendActivity(body, '2026-07-13T19:00Z created');
    expect(out.endsWith('## Activity\n- 2026-07-13T19:00Z created\n')).toBe(true);
  });
  it('accumulates multiple entries in order', () => {
    let body = '\n## Activity\n';
    body = appendActivity(body, 'first');
    body = appendActivity(body, 'second');
    expect(body).toContain('- first\n- second\n');
  });
  it('creates the section when missing', () => {
    const out = appendActivity('\n## Description\n\nX\n', 'note');
    expect(out).toContain('## Activity\n\n- note\n');
  });
  it('creates a real section when body only mentions "## Activity" mid-sentence', () => {
    const body = '\n## Description\n\nSee the ## Activity section rules for details.\n';
    const out = appendActivity(body, 'note');
    expect(out).toMatch(/\n## Activity\n\n- note\n$/);
  });
  it('creates a real section when body only has a "### Activity" sub-heading', () => {
    const body = '\n## Description\n\nX\n\n### Activity\n';
    const out = appendActivity(body, 'note');
    expect(out).toMatch(/\n## Activity\n\n- note\n$/);
  });
});
