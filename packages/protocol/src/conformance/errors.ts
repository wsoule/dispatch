// A step or world change this adapter does not implement; the stdio adapter
// answers `unsupported` for the vector instead of an observation.
export class UnsupportedOp extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOp';
  }
}
