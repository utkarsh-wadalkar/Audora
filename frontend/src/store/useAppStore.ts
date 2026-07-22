import { create } from 'zustand';
import { api } from '../api/client';

export interface Track {
  id?: number;
  file_path: string;
  title?: string;
  artist?: string;
  album?: string;
  duration: number;
  file_size: number;
  format?: string;
}

interface AppState {
  // Live status
  dockerStatus: boolean;
  wrapperStatus: boolean;
  authStatus: boolean;
  pending2fa: boolean;

  // UI
  loginModalOpen: boolean;
  setupComplete: boolean | null; // null = unknown/loading

  // Player
  currentTrack: Track | null;
  isPlaying: boolean;

  // Actions
  refreshStatus: () => Promise<void>;
  checkSetup: () => Promise<void>;
  markSetupComplete: () => void;
  openLogin: () => void;
  closeLogin: () => void;
  startDownload: (url: string, format?: string) => Promise<boolean>;
  cancelDownload: () => Promise<void>;
  addToQueue: (url: string) => Promise<void>;
  setCurrentTrack: (track: Track | null) => void;
  setIsPlaying: (playing: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  dockerStatus: false,
  wrapperStatus: false,
  authStatus: false,
  pending2fa: false,
  loginModalOpen: false,
  setupComplete: null,
  currentTrack: null,
  isPlaying: false,

  refreshStatus: async () => {
    try {
      const [d, w, a] = await Promise.all([
        api.get('/docker/status'),
        api.get('/wrapper/status'),
        api.get('/auth/status'),
      ]);
      set({
        dockerStatus: !!d.data.data?.running,
        wrapperStatus: !!w.data.data?.running,
        authStatus: !!a.data.data?.logged_in,
        pending2fa: !!a.data.data?.pending_2fa,
      });
    } catch {
      // Backend not up yet — leave state as-is.
    }
  },

  openLogin: () => set({ loginModalOpen: true }),
  closeLogin: () => set({ loginModalOpen: false }),

  checkSetup: async () => {
    try {
      const r = await api.get('/setup/status');
      set({ setupComplete: !!r.data.data?.complete });
    } catch {
      // If the backend isn't up yet, assume not complete so we don't skip it.
      set({ setupComplete: false });
    }
  },

  markSetupComplete: () => set({ setupComplete: true }),

  startDownload: async (url, format) => {
    try {
      const res = await api.post('/download', { url, format });
      return !!res.data.success;
    } catch {
      return false;
    }
  },

  cancelDownload: async () => {
    try {
      await api.post('/download/cancel');
    } catch {
      // ignore
    }
  },

  addToQueue: async (url) => {
    await api.post('/queue', { url });
  },

  setCurrentTrack: (track) => set({ currentTrack: track, isPlaying: !!track }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
}));
