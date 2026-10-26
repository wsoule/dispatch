/**
 * Parser-blocking script for the start of <body>, next to themeScript():
 * applies the remembered collapsed rail (html[data-shell-collapsed]) before
 * first paint, so a collapsed sidebar does not flash open and shift the page
 * while React hydrates. Pass the same key as AppShell's `storageKey`.
 * Storage failures (private mode) leave the sidebar expanded.
 */
export function sidebarCollapseScript(storageKey: string): string {
  const key = JSON.stringify(storageKey);
  return `(function(){try{if(localStorage.getItem(${key})==="1"){document.documentElement.dataset.shellCollapsed="true";}}catch(e){}})();`;
}
