import axios from 'axios';

export interface DesktopUpdateState {
  phase: 'idle' | 'available' | 'downloading' | 'ready' | 'installing';
  version?: string;
  percent?: number;
  message?: string;
}

// Electron preload bridge (optional — undefined in a plain browser).
export const electronAPI: {
  backendPort?: number;
  openFolder?: (path: string) => Promise<void>;
  showNotification?: (opts: { title: string; body: string }) => Promise<void>;
  selectFolder?: () => Promise<string | null>;
  adjustZoom?: (steps: number) => Promise<void>;
  getUpdateState?: () => Promise<DesktopUpdateState | null>;
  downloadUpdate?: () => Promise<void>;
  installUpdate?: () => Promise<void>;
  onUpdateState?: (callback: (state: DesktopUpdateState) => void) => () => void;
} = (window as any).electronAPI || {};

const backendPort = electronAPI.backendPort ?? 8000;
export const API_BASE = `http://localhost:${backendPort}`;
export const WS_BASE = `ws://localhost:${backendPort}`;

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
});
