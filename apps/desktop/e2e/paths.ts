import { resolve } from 'node:path';

// Shared by playwright.config.ts and global-setup.ts so the harness's
// storefront fixture root/home and ports stay a single source of truth.
export const REPO = resolve(import.meta.dirname, '../../..');
export const ROOT = resolve(REPO, '.agents/ignore/storefront');
export const HOME = resolve(REPO, '.agents/ignore/storefront-home');
export const DAEMON_PORT = 57999;
export const VITE_PORT = 5199;
