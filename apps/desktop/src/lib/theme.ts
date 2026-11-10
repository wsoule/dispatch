// The localStorage key for the person's theme choice. It holds only 'light'
// or 'dark'; no key means follow the OS (html[data-theme="system"]). This
// module imports nothing because vite.config.ts imports it at build time,
// in Node, to inline the pre-paint theme script.
export const THEME_STORAGE_KEY = 'dispatch:theme';
