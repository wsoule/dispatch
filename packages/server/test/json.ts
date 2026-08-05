// Reads a JSON response body for assertions.
//
// `Response.json()` types as `Promise<unknown>` under this repo's strict,
// DOM-less tsconfig, and the API suites assert on arbitrary response shapes
// (health payloads, error bodies, task docs, plan proposals). Declaring a
// response type per endpoint would bury each assertion under scaffolding, so
// the `any` escape hatch lives here — once — instead of being re-declared in
// every `*-api.test.ts`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function json(res: Response): Promise<any> {
  return res.json();
}
