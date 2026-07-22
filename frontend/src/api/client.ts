import axios from 'axios';

export const API_BASE = 'http://localhost:8000';
export const WS_BASE = 'ws://localhost:8000';

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
});

// Electron preload bridge (optional — undefined in a plain browser).
export const electronAPI: {
  openFolder?: (path: string) => Promise<void>;
  showNotification?: (opts: { title: string; body: string }) => Promise<void>;
  selectFolder?: () => Promise<string | null>;
} = (window as any).electronAPI || {};
