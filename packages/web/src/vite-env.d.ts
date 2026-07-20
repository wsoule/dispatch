/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Base URL dispatchd's API/WS live at. Empty (the default) means "same
  // origin as this page" — dispatchd serves this app's own static files, so
  // that's the common case; a non-empty value is the Tauri-ready seam for a
  // desktop shell pointing at a daemon it spawned on some other port.
  readonly VITE_DISPATCH_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
