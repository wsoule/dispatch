#!/usr/bin/env bun
// dispatchd's entry. The same binary runs the terminal host when asked, so a
// compiled sidecar needs no second executable; each side loads only its code.
if (process.argv.includes('--terminal-host')) {
  await import('./terminalHostMain.js');
} else {
  await import('./daemonMain.js');
}

export {};
