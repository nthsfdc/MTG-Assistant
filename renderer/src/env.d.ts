/// <reference types="vite/client" />

import type { MainApi } from '../../electron/preload';

declare global {
  interface Window {
    api: MainApi;
  }
}
