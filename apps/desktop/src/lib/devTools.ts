// Gates the hidden "dispatch with the fake executor" control the Tasks tab
// shows next to the normal Dispatch button — per the plan, the API's
// `executor: 'fake'` param stays reachable for a manual smoke (a FakeExecutor
// run through the real API/UI), but only for someone who's deliberately
// opted in, never as a default a real user could hit by accident. Toggle it
// from a browser devtools console with:
//   localStorage.setItem('dispatch.devFakeExecutor', '1')
const DEV_FAKE_EXECUTOR_KEY = 'dispatch.devFakeExecutor';

export function isFakeExecutorDevToolEnabled(): boolean {
  try {
    return window.localStorage.getItem(DEV_FAKE_EXECUTOR_KEY) === '1';
  } catch {
    // localStorage can throw in a locked-down webview (e.g. private
    // browsing in some embedders) — treat that the same as "not set".
    return false;
  }
}
