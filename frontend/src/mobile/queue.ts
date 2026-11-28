import type { Track } from './catalog';

export type QueueAfterRescan = {
  queue: Track[];
  /** Position of the current track in the new queue, or -1 when it was removed. */
  index: number;
  /** First surviving track after the removed current track, or -1 when none remains. */
  following: number;
};

/** Drops tracks that a rescan removed and refreshes the rest with their rescanned details. */
export function pruneQueue(queue: Track[], index: number, library: Track[]): QueueAfterRescan {
  const available = new Map(library.map((track) => [track.id, track]));
  const kept: Track[] = [];
  let current = -1;
  let following = -1;
  queue.forEach((track, position) => {
    const refreshed = available.get(track.id);
    if (!refreshed) return;
    if (position === index) current = kept.length;
    else if (position > index && current < 0 && following < 0) following = kept.length;
    kept.push(refreshed);
  });
  return { queue: kept, index: current, following: current < 0 ? following : -1 };
}
