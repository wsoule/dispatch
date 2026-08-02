import type { ApiClient, RunMeta } from '@dispatch/client';

// `@dispatch/client`'s barrel doesn't re-export these mirrored server
// types, so they're derived from the `ApiClient` interface it does export.
export type FixLoopState = Awaited<ReturnType<ApiClient['fetchFixLoop']>>;
export type VerificationResult = Awaited<
  ReturnType<ApiClient['fetchTaskVerification']>
>;
export type AdjudicateFindingInput = Parameters<
  ApiClient['adjudicateFinding']
>[2];
export type AdjudicateFindingResult = Awaited<
  ReturnType<ApiClient['adjudicateFinding']>
>;
export type RunKind = NonNullable<RunMeta['kind']>;
