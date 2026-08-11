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

// Same contract for the warden chat: with this set, new warden conversations
// open against the daemon's 'fake' backend (registered only when dispatchd
// runs with DISPATCH_ENABLE_FAKES=1) instead of the real Claude one — the
// hook the desktop e2e suite uses to drive the confirm/deny flow without a
// live LLM call. Toggle from a devtools console with:
//   localStorage.setItem('dispatch.devFakeWarden', '1')
const DEV_FAKE_WARDEN_KEY = 'dispatch.devFakeWarden';

export function isFakeWardenDevToolEnabled(): boolean {
  try {
    return window.localStorage.getItem(DEV_FAKE_WARDEN_KEY) === '1';
  } catch {
    return false;
  }
}
