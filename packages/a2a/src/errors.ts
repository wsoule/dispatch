export type A2AReason =
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_CANCELABLE'
  | 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  | 'UNSUPPORTED_OPERATION'
  | 'CONTENT_TYPE_NOT_SUPPORTED'
  | 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'
  | 'VERSION_NOT_SUPPORTED'
  | 'INVALID_PARAMS';

// An A2A-domain error (a2a-protocol.org); handleA2A writes it as google.rpc.Status.
export class A2AError extends Error {
  constructor(
    readonly reason: A2AReason,
    message: string
  ) {
    super(message);
    this.name = 'A2AError';
  }
}
