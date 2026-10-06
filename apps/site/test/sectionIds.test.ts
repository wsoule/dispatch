import { satteri } from '@astrojs/markdown-satteri';
import { expect, it } from 'bun:test';

import { sectionIdFor, sectionIds } from '../src/lib/sectionIds';

it('gives numbered and appendix headings their s<number> id', () => {
  expect(sectionIdFor('6.2 Mode selection')).toBe('s6.2');
  expect(sectionIdFor('Appendix C Dispatch profile')).toBe('sC');
  expect(sectionIdFor('C.3 Gate types')).toBe('sC.3');
  expect(sectionIdFor('A2A binding notes')).toBeNull();
});

it("sets the id on h1-h4 headings in Astro's markdown processor", async () => {
  const renderer = await satteri({
    hastPlugins: [sectionIds()],
  }).createRenderer({ syntaxHighlight: false });
  const { code } = await renderer.render(
    [
      '# 5 Gates',
      '## 5.9 The wake gate',
      '#### 12.4.1 Vector files',
      '##### 6.2 Too deep',
      '## A2A binding notes',
    ].join('\n\n')
  );
  expect(code).toContain('<h1 id="s5">');
  expect(code).toContain('<h2 id="s5.9">');
  expect(code).toContain('<h4 id="s12.4.1">');
  expect(code).not.toContain('id="s6.2"');
  expect(code).not.toContain('id="sA2A');
});
