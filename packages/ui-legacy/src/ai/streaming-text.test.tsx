import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { closeOpenFence, StreamingText } from './streaming-text';

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
});
