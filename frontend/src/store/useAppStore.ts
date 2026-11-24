import { create } from 'zustand';
import { api } from '../api/client';
import { restoreUpcoming, shuffleUpcoming } from '../lib/playbackOrder';

export interface Track {
  id?: number;
  artwork_revision?: string | null;
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
  images?: { downloader?: boolean; audora_downloader?: boolean; wrapper?: boolean };
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
  libraryOnly: boolean;

  // Setup-step state machine (QC_plan §6.1), keyed by step id.
  setupSteps: Record<string, SetupStepState>;

  // Player
  currentTrack: Track | null;
  isPlaying: boolean;
  playbackQueue: Track[];
  basePlaybackQueue: Track[];
  playbackIndex: number;
  playbackRequestId: number;
  shuffleEnabled: boolean;
  repeatMode: 'off' | 'all' | 'one';

  // Actions
  refreshStatus: () => Promise<void>;
  checkSetup: () => Promise<void>;
  markSetupComplete: () => void;
  markLibraryOnly: () => void;
  applySetupEvent: (event: SetupProgressEvent) => void;
  seedSetupSteps: (snapshot: SetupStatusSnapshot) => void;
  openLogin: () => void;
  closeLogin: () => void;
  startDownload: (url: string) => Promise<boolean>;
  cancelDownload: () => Promise<void>;
  addToQueue: (url: string) => Promise<void>;
  setCurrentTrack: (track: Track | null) => void;
  playTracks: (tracks: Track[], startTrack?: Track) => void;
  playNext: () => boolean;
  playPrevious: () => boolean;
  finishTrack: () => boolean;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  addPlayNext: (track: Track) => void;
  addToPlaybackEnd: (track: Track) => void;
  removeUpcoming: (index: number) => void;
  moveUpcoming: (from: number, to: number) => void;
  clearUpcoming: () => void;
  playQueueIndex: (index: number) => void;
  setIsPlaying: (playing: boolean) => void;
}

const sameTrack = (first: Track, second: Track) =>
  first.id != null && second.id != null
    ? first.id === second.id
    : first.file_path === second.file_path;

export const useAppStore = create<AppState>((set) => ({
  dockerStatus: false,
  wrapperStatus: false,
  authStatus: false,
  pending2fa: false,
  loginModalOpen: false,
  setupComplete: null,
  libraryOnly: false,
  setupSteps: {},
  currentTrack: null,
  isPlaying: false,
  playbackQueue: [],
  basePlaybackQueue: [],
  playbackIndex: -1,
  playbackRequestId: 0,
  shuffleEnabled: false,
  repeatMode: 'off',

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
      const r = await api.get('/setup/status', { params: { include_system: false } });
      const setupComplete = !!r.data.data?.complete;
      set({ setupComplete, libraryOnly: !setupComplete && !!r.data.data?.library_only });
    } catch {
      // If the backend isn't up yet, assume not complete so we don't skip it.
      set({ setupComplete: false });
    }
  },

  markSetupComplete: () => set({ setupComplete: true, libraryOnly: false }),
  markLibraryOnly: () => set({ setupComplete: false, libraryOnly: true }),

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
      seedDone('build_downloader', images.audora_downloader, 'Already prepared');
      seedDone('build_wrapper', images.wrapper, 'Already ready');
      return { setupSteps: merged };
    }),

  startDownload: async (url) => {
    try {
      // No format: Audora always downloads the lossless source and converts it
      // to FLAC before reporting the track ready.
      const res = await api.post('/download', { url });
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

  setCurrentTrack: (track) =>
    set((state) => {
      if (!track) return { currentTrack: null, isPlaying: false };
      const isAlreadyQueued = state.playbackQueue.some((queued) => sameTrack(queued, track));
      return {
        currentTrack: track,
        isPlaying: true,
        playbackQueue: isAlreadyQueued ? state.playbackQueue : [track],
        basePlaybackQueue: isAlreadyQueued ? state.basePlaybackQueue : [track],
        playbackIndex: isAlreadyQueued
          ? state.playbackQueue.findIndex((queued) => sameTrack(queued, track)) : 0,
        playbackRequestId: state.playbackRequestId + 1,
      };
    }),
  playTracks: (tracks, startTrack) => {
    const playableTracks = tracks.filter((track) => track.id != null);
    const requestedStart = startTrack
      ? playableTracks.find((track) => sameTrack(track, startTrack))
      : undefined;
    const firstTrack = requestedStart ?? playableTracks[0] ?? null;
    set((state) => ({
      playbackQueue: state.shuffleEnabled ? shuffleUpcoming(
        [firstTrack, ...playableTracks.filter((track) => track !== firstTrack)].filter((track): track is Track => !!track), 0,
      ) : playableTracks,
      basePlaybackQueue: playableTracks,
      playbackIndex: firstTrack ? (state.shuffleEnabled ? 0 : playableTracks.indexOf(firstTrack)) : -1,
      playbackRequestId: state.playbackRequestId + 1,
      currentTrack: firstTrack,
      isPlaying: !!firstTrack,
    }));
  },
  playNext: () => {
    let advanced = false;
    set((state) => {
      if (!state.currentTrack) return { isPlaying: false };
      const nextIndex = state.playbackIndex + 1;
      const nextTrack = state.playbackQueue[nextIndex];
      if (!nextTrack) {
        if (state.repeatMode !== 'all' || !state.playbackQueue.length) return { isPlaying: false };
        advanced = true;
        return { currentTrack: state.playbackQueue[0], playbackIndex: 0, isPlaying: true };
      }
      advanced = true;
      return { currentTrack: nextTrack, playbackIndex: nextIndex, isPlaying: true };
    });
    return advanced;
  },
  playPrevious: () => {
    let moved = false;
    set((state) => {
      if (!state.currentTrack) return {};
      const previousTrack = state.playbackQueue[state.playbackIndex - 1];
      if (!previousTrack) return {};
      moved = true;
      return { currentTrack: previousTrack, playbackIndex: state.playbackIndex - 1, isPlaying: true };
    });
    return moved;
  },
  finishTrack: () => {
    let continuePlaying = false;
    set((state) => {
      if (!state.currentTrack) return { isPlaying: false };
      if (state.repeatMode === 'one') {
        continuePlaying = true;
        return { isPlaying: true };
      }
      const nextIndex = state.playbackIndex + 1;
      if (nextIndex < state.playbackQueue.length) {
        continuePlaying = true;
        return { currentTrack: state.playbackQueue[nextIndex], playbackIndex: nextIndex, isPlaying: true };
      }
      if (state.repeatMode !== 'all' || !state.playbackQueue.length) return { isPlaying: false };
      continuePlaying = true;
      const order = state.shuffleEnabled
        ? shuffleUpcoming(state.playbackQueue, -1)
        : [...state.playbackQueue];
      if (order.length > 1 && sameTrack(order[0], state.currentTrack)) {
        [order[0], order[1]] = [order[1], order[0]];
      }
      return { playbackQueue: order, currentTrack: order[0], playbackIndex: 0, isPlaying: true };
    });
    return continuePlaying;
  },
  toggleShuffle: () => set((state) => {
    const shuffleEnabled = !state.shuffleEnabled;
    return {
      shuffleEnabled,
      playbackQueue: shuffleEnabled
        ? shuffleUpcoming(state.playbackQueue, state.playbackIndex)
        : restoreUpcoming(state.playbackQueue, state.basePlaybackQueue, state.playbackIndex, sameTrack),
    };
  }),
  cycleRepeat: () => set((state) => ({
    repeatMode: state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off',
  })),
  addPlayNext: (track) => set((state) => {
    if (track.id == null) return {};
    if (!state.currentTrack) return {
      currentTrack: track, isPlaying: true, playbackQueue: [track],
      basePlaybackQueue: [track], playbackIndex: 0,
    };
    const queue = [...state.playbackQueue];
    const laterIndex = queue.findIndex((item, index) => index > state.playbackIndex && sameTrack(item, track));
    if (laterIndex >= 0) queue.splice(laterIndex, 1);
    queue.splice(state.playbackIndex + 1, 0, track);
    const basePlaybackQueue = [...state.basePlaybackQueue];
    const baseCurrentIndex = basePlaybackQueue.findIndex((item) => sameTrack(item, state.currentTrack as Track));
    const baseLaterIndex = basePlaybackQueue.findIndex((item, index) =>
      index > baseCurrentIndex && sameTrack(item, track)
    );
    if (baseLaterIndex >= 0) basePlaybackQueue.splice(baseLaterIndex, 1);
    basePlaybackQueue.splice(baseCurrentIndex + 1, 0, track);
    return {
      playbackQueue: queue,
      basePlaybackQueue,
    };
  }),
  addToPlaybackEnd: (track) => set((state) => {
    if (track.id == null) return {};
    if (!state.currentTrack) return {
      currentTrack: track, isPlaying: true, playbackQueue: [track],
      basePlaybackQueue: [track], playbackIndex: 0,
    };
    return {
      playbackQueue: [...state.playbackQueue, track],
      basePlaybackQueue: [...state.basePlaybackQueue, track],
    };
  }),
  removeUpcoming: (index) => set((state) => {
    if (index <= state.playbackIndex || index >= state.playbackQueue.length) return {};
    const playbackQueue = [...state.playbackQueue];
    playbackQueue.splice(index, 1);
    return { playbackQueue };
  }),
  moveUpcoming: (from, to) => set((state) => {
    if (from <= state.playbackIndex || to <= state.playbackIndex ||
        from >= state.playbackQueue.length || to >= state.playbackQueue.length) return {};
    const playbackQueue = [...state.playbackQueue];
    playbackQueue.splice(to, 0, ...playbackQueue.splice(from, 1));
    return { playbackQueue, basePlaybackQueue: [...playbackQueue] };
  }),
  clearUpcoming: () => set((state) => ({
    playbackQueue: state.playbackQueue.slice(0, state.playbackIndex + 1),
  })),
  playQueueIndex: (index) => set((state) => {
    if (index <= state.playbackIndex || index >= state.playbackQueue.length) return {};
    return { currentTrack: state.playbackQueue[index], playbackIndex: index, playbackRequestId: state.playbackRequestId + 1, isPlaying: true };
  }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
}));
