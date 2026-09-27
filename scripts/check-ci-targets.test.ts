import { describe, expect, it } from 'bun:test';

import { missingProjectTargets } from './check-ci-targets.ts';

// A ci.yml whose `moon ci` block names `targets`; the comment above the step
// names :conformance too, and must not count.
const workflow = (targets: string): string =>
  [
    'jobs:',
    '  ci:',
    '    steps:',
    '      # moon ci also runs :conformance (prose, not a target)',
    '      - name: moon ci',
    '        run: >-',
    `          moon ci --include-relations :build :typecheck :test ${targets}`,
    '          root:format-check',
    '',
    '      - name: Audit (full report)',
    '        run: pnpm audit',
    '',
  ].join('\n');

const verify = (commands: readonly string[]): string =>
  [
    'verifySteps:',
    ...commands.flatMap((c) => ['  - name: step', `    command: ${c}`]),
    'models:',
    '  plan: x',
    '',
  ].join('\n');

describe('missingProjectTargets', () => {
  it('passes when ci.yml and verifySteps both run :conformance', () => {
    expect(
      missingProjectTargets(
        workflow(':conformance'),
        verify(['moon run :test', 'moon run :conformance'])
      )
    ).toEqual([]);
  });

  it('reports :conformance missing from ci.yml, even when a comment names it', () => {
    expect(
      missingProjectTargets(
        workflow(''),
        verify(['moon run :conformance'])
      ).join('\n')
    ).toContain("ci.yml's `moon ci` target list does not name :conformance");
  });

  it('reports it missing from verifySteps, where a step name does not count', () => {
    const named =
      'verifySteps:\n  - name: moon run :conformance\n    command: moon run :test\n';
    expect(
      missingProjectTargets(workflow(':conformance'), named).join('\n')
    ).toContain('verifySteps');
  });

  it('does not count a verifySteps command after the block ends', () => {
    const after = `${verify(['moon run :test'])}other:\n  command: moon run :conformance\n`;
    expect(
      missingProjectTargets(workflow(':conformance'), after).join('\n')
    ).toContain('verifySteps');
  });
});
