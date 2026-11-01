import { act, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import {
  closeOpenFence,
  splitSettledMarkdown,
  StreamingText,
} from './streaming-text';

describe('closeOpenFence', () => {
  test('leaves text with no open fence alone', () => {
    expect(closeOpenFence('Plain words.')).toBe('Plain words.');
    const closed = 'Run:\n```sh\nbun test\n```\nDone.';
    expect(closeOpenFence(closed)).toBe(closed);
  });

  test('closes a fence still open at the end', () => {
    expect(closeOpenFence('Run:\n```sh\nbun test')).toBe(
      'Run:\n```sh\nbun test\n```'
    );
    // A text that stops at a line break gets the fence on the next line.
    expect(closeOpenFence('```ts\nconst a = 1;\n')).toBe(
      '```ts\nconst a = 1;\n```'
    );
  });

  test('closes with the fence it opened with', () => {
    expect(closeOpenFence('~~~~\nx')).toBe('~~~~\nx\n~~~~');
    // A shorter fence of the same kind is code, not the close.
    expect(closeOpenFence('````md\n```\nx')).toBe('````md\n```\nx\n````');
  });

  test('a half-typed closing fence becomes the whole fence', () => {
    expect(closeOpenFence('```sh\nbun test\n``')).toBe('```sh\nbun test\n```');
  });

  test('an opener with nothing after it yet is closed, not mistaken for a close', () => {
    expect(closeOpenFence('Here:\n```')).toBe('Here:\n```\n```');
  });

  test('a backtick run with a backtick in its info string opens nothing', () => {
    const inline = '```not `a` fence';
    expect(closeOpenFence(inline)).toBe(inline);
  });
});

describe('splitSettledMarkdown', () => {
  test('ends a block at a blank line before a new one, keeping the open one as the tail', () => {
    const text = 'One.\n\nTwo,\nstill two.\n\n- a list';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: ['One.\n', 'Two,\nstill two.\n'],
      tail: '- a list',
    });
  });

  test('every block and the tail add up to the text', () => {
    for (const text of [
      '',
      'no break',
      'trailing\n\n',
      'a\n\n\n\nb\n\nc\n',
      '```\nx\n\ny\n```\n\nafter',
    ]) {
      const { settled, tail } = splitSettledMarkdown(text);
      expect([...settled, tail].join('\n')).toBe(text);
    }
  });

  test('waits for what follows a blank line before ending the block', () => {
    expect(splitSettledMarkdown('Done.\n\n')).toEqual({
      settled: [],
      tail: 'Done.\n\n',
    });
  });

  test('never ends a block inside a code fence', () => {
    const text = 'Run:\n\n```sh\nbun test\n\nbun run lint\n```\n\nDone.';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: ['Run:\n', '```sh\nbun test\n\nbun run lint\n```\n'],
      tail: 'Done.',
    });
    // A fence still open keeps everything after it in the tail.
    expect(splitSettledMarkdown('A.\n\n```\nx\n\ny').tail).toBe('```\nx\n\ny');
  });

  // A list item's next paragraph and an indented code block continue what
  // is above them.
  test('keeps an indented line with the block it continues', () => {
    const text = '1. Step one\n\n   more on step one\n\n2. Step two';
    expect(splitSettledMarkdown(text)).toEqual({
      settled: ['1. Step one\n\n   more on step one\n'],
      tail: '2. Step two',
    });
  });
});

describe('StreamingText', () => {
  test('without render, the text is a paragraph', () => {
    const { container } = render(<StreamingText text="All quiet." streaming />);
    expect(container.querySelector('p')?.textContent).toBe('All quiet.');
  });

  // The app hands in its Markdown component; the slot gets the text with an open
  // fence closed and draws it on its own, with no paragraph or caret around it.
  test('render draws the shown text with an open fence closed', () => {
    const seen: string[] = [];
    const { container } = render(
      <StreamingText
        text={'Run:\n```sh\nbun test'}
        streaming
        render={(text) => {
          seen.push(text);
          return <div data-testid="rendered">{text}</div>;
        }}
      />
    );
    expect(seen.at(-1)).toBe('Run:\n```sh\nbun test\n```');
    expect(screen.getByTestId('rendered')).toBeDefined();
    expect(container.querySelector('p')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  // A text that keeps growing (a CLI agent's whole output) draws each block
  // once: a read redraws the open block, not everything before it.
  test('blocks draws each finished block once and reveals only the open one', () => {
    const drawn: string[] = [];
    const draw = (text: string) => {
      drawn.push(text);
      return <div data-testid="block">{text}</div>;
    };
    const { rerender } = render(
      <StreamingText
        text={'One.\n\nTwo.\n\nThr'}
        streaming
        blocks
        render={draw}
      />
    );
    expect(screen.getAllByTestId('block').map((b) => b.textContent)).toEqual([
      'One.\n',
      'Two.\n',
      'Thr',
    ]);

    drawn.length = 0;
    act(() => {
      rerender(
        <StreamingText
          text={'One.\n\nTwo.\n\nThree.\n\nFo'}
          streaming
          blocks
          render={draw}
        />
      );
    });
    expect(drawn).not.toContain('One.\n');
    expect(drawn).not.toContain('Two.\n');
    expect(drawn).toContain('Three.\n');
    expect(screen.getAllByTestId('block').map((b) => b.textContent)).toEqual([
      'One.\n',
      'Two.\n',
      'Three.\n',
      'Fo',
    ]);
  });
});
