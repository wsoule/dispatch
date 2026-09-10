import { describe, expect, test } from 'bun:test';

import { buildMilestonePrompt } from './milestonePrompt';

describe('buildMilestonePrompt', () => {
  test('a suggested group carries its title, reason, and every item', () => {
    const prompt = buildMilestonePrompt({
      title: 'Worktree hygiene',
      reason: 'All three touch stale worktree cleanup.',
      items: ['wt pool leaks dirs', 'stale servers linger'],
    });
    expect(prompt).toContain('one epic: "Worktree hygiene"');
    expect(prompt).toContain(
      'Why they belong together: All three touch stale worktree cleanup.'
    );
    expect(prompt).toContain('- wt pool leaks dirs');
    expect(prompt).toContain('- stale servers linger');
    expect(prompt).toContain('cover every item above');
  });

  test('a hand-picked selection has no title or reason lines', () => {
    const prompt = buildMilestonePrompt({ items: ['a', 'b'] });
    expect(prompt).toContain('as one epic.');
    expect(prompt).not.toContain('Why they belong together');
    expect(prompt).toContain('- a\n- b');
  });

  test('blank title and reason are treated as absent', () => {
    const prompt = buildMilestonePrompt({
      title: '  ',
      reason: '',
      items: ['x'],
    });
    expect(prompt).toContain('as one epic.');
    expect(prompt).not.toContain('""');
  });
});
