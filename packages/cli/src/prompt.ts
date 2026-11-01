import { createInterface } from 'node:readline';

// Yes/no on the terminal, no by default: this guards a risk. No without a TTY.
export async function confirmNo(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stderr.write(`${question} [y/N] `);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.once('line', resolve)
    );
    return /^y/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
