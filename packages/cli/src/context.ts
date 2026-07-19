export interface CliContext {
  cwd: string;
  log: (line: string) => void;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message);
    this.name = 'CliError';
  }
}
