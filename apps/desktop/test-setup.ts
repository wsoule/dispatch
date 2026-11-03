// Registers happy-dom's globals so `bun test` can render React; unmounts between
// tests. @testing-library/react is imported dynamically because a static import
// hoists above `register()`, and its `screen` singleton captures `document.body`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach } from 'bun:test';

GlobalRegistrator.register();

const { cleanup } = await import('@testing-library/react');

// Every test file shares this one document, so state a test leaves on it
// leaks into whichever file bun runs next, and file order differs between
// machines. A text selection is such state: IssuesView's bare Cmd+C copies a
// row's id only when nothing is selected, and DraftView's prompt-menu tests
// select prompt text, so in CI's order the copy test saw their selection.
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});
