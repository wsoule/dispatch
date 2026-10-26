/**
 * Parser-blocking script for the first thing in <body>: the saved choice
 * wins, else the OS preference, applied to html[data-theme] before first
 * paint so there is no flash of the wrong theme. Persistence failures
 * (private mode) are tolerated.
 */
export function themeScript(storageKey: string): string {
  const key = JSON.stringify(storageKey);
  return `(function(){try{var t=localStorage.getItem(${key});if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();`;
}
