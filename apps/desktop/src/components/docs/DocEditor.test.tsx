import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { DocEditor } from './DocEditor';

const ignore = (): void => undefined;

// happy-dom has no layout, so one is given by hand: an element sits a pixel
// lower for each character before it, as if every long line wrapped.
test('scrolls to where a wrapped heading lays out, not to its line number', () => {
  const offsetTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetTop'
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      let px = 0;
      for (let n = this.previousSibling; n !== null; n = n.previousSibling) {
        px += n.textContent?.length ?? 0;
      }
      return px;
    },
  });
  try {
    const paragraph = 'word '.repeat(80);
    const text = `# Doc\n${paragraph}\n${paragraph}\n## API\nroutes\n`;
    render(
      <DocEditor
        text={text}
        label="Editing doc"
        previewing={false}
        readOnly={false}
        onChange={ignore}
        placeAt={{ line: 3 }}
      />
    );
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Editing doc');
    expect(editor.selectionStart).toBe(text.indexOf('## API'));
    expect(editor.scrollTop).toBe(text.indexOf('## API'));
    // The measuring copy is gone: only the render container is left.
    expect(document.body.childElementCount).toBe(1);
  } finally {
    if (offsetTop === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
    } else {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
    }
  }
});
