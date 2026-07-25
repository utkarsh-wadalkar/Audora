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

// ---------------------------------------------------------------------------
// Setup-step state slice (QC_plan.md §6.1 state machine, Workstream E).
//
// Each setup step is modeled independently as pending → running → (done|error),
// and error → running on retry. This mirrors exactly what `/ws/setup` emits
// (see backend app.py `setup_callback` canonical schema) plus what we seed from
// `GET /setup/status` on mount / reconnect (no-late-join-replay mitigation).
// ---------------------------------------------------------------------------
export type SetupStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface SetupStepError {
  code: string;
  transient: boolean;
}

export interface SetupStepProgress {
  current: number; // real aggregated bytes downloaded
  total: number; // real aggregated bytes total
}

export interface SetupStepState {
  status: SetupStepStatus;
  message: string;
  percent?: number; // 0..100 on streamed pull ticks
  progress?: SetupStepProgress; // real aggregate byte counts
  error?: SetupStepError; // present only when status === 'error'
}

/** The raw `setup_progress` event as forwarded verbatim by `/ws/setup`. */
export interface SetupProgressEvent {
  type: 'setup_progress';
  step: string;
  status: SetupStepStatus;
  message?: string;
  percent?: number;
  progress?: SetupStepProgress;
  error?: SetupStepError;
}

/** Shape of the `images` block inside `GET /setup/status`. */
export interface SetupStatusSnapshot {
  images?: { downloader?: boolean; wrapper?: boolean };
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

  // Setup-step state machine (QC_plan §6.1), keyed by step id.
  setupSteps: Record<string, SetupStepState>;

  // Player
  currentTrack: Track | null;
  isPlaying: boolean;

  // Actions
  refreshStatus: () => Promise<void>;
  checkSetup: () => Promise<void>;
  markSetupComplete: () => void;
  applySetupEvent: (event: SetupProgressEvent) => void;
  seedSetupSteps: (snapshot: SetupStatusSnapshot) => void;
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
  setupSteps: {},
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

  // Apply an incoming `/ws/setup` `setup_progress` event to the step slice.
  // Merges by step id so a running tick's percent/progress accumulates and an
  // 'error' event carries its taxonomy code. On any non-error status we drop a
  // stale `error` so a failed→running retry visibly clears the failure UI.
  applySetupEvent: (event) =>
    set((state) => {
      if (!event || event.type !== 'setup_progress' || !event.step) return {};
      const prev = state.setupSteps[event.step];
      const next: SetupStepState = {
        status: event.status,
        message: event.message ?? prev?.message ?? '',
        // Carry the last known progress/percent forward on ticks that omit it,
        // but never fabricate: absence just means "no new byte data this tick".
        percent: event.percent ?? prev?.percent,
        progress: event.progress ?? prev?.progress,
        error: event.status === 'error' ? event.error : undefined,
      };
      return { setupSteps: { ...state.setupSteps, [event.step]: next } };
    }),

  // Seed step state from a `GET /setup/status` snapshot. This is the
  // no-late-join-replay mitigation (Workstream C flag 1): `/ws/setup` never
  // replays already-finished state, so on mount / reconnect we derive the
  // "already done" steps from the REST snapshot's `images` booleans. We never
  // downgrade a step already live in the store (e.g. mid-pull) — seeding only
  // fills gaps and marks pre-existing images as done, so a reconnect never
  // blanks or freezes an in-flight panel.
  seedSetupSteps: (snapshot) =>
    set((state) => {
      const images = snapshot?.images ?? {};
      const merged: Record<string, SetupStepState> = { ...state.setupSteps };
      const seedDone = (step: string, present: boolean | undefined, label: string) => {
        const existing = merged[step];
        // Preserve anything already running/error/done from live events.
        if (existing && existing.status !== 'pending') return;
        merged[step] = present
          ? { status: 'done', message: label }
          : existing ?? { status: 'pending', message: '' };
      };
      seedDone('pull_downloader', images.downloader, 'Already downloaded');
      seedDone('build_wrapper', images.wrapper, 'Already built');
      return { setupSteps: merged };
    }),

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
