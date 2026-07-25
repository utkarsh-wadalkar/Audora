import { useEffect, useRef, useState } from 'react';
import LiveProgressPanel, { PullEvent } from './LiveProgressPanel';

/**
 * LiveProgressPanelDemo — standalone dev harness for LiveProgressPanel.
 *
 * There is NO Vitest/Storybook in this project (see package.json: only `dev`
 * and `build`), so this is a plain dev page. It generates a realistic Docker
 * pull event SEQUENCE that matches QC_plan §3.3, then feeds those events into
 * <LiveProgressPanel> OVER TIME via setInterval so the aggregate bar, speed,
 * ETA, and per-layer terminal log are all visually verifiable with NO backend
 * running.
 *
 * IMPORTANT: This drives the DEMO'S OWN event stream — it is a mock data
 * source, not fake progress inside the panel. The panel still derives every
 * number purely from the (mock) events handed to it, exactly as it will from
 * real ws/setup events in production.
 *
 * How to view: run `npm run dev` and open the app with `?panelDemo=1` in the
 * URL (the mount hook lives in src/main.tsx). See report for details.
 */

// A scripted event for the timeline: emitted at `atMs` after start.
interface ScriptedEvent {
  atMs: number;
  event: PullEvent;
}

// Build a realistic multi-layer pull timeline. Each layer goes:
//   Downloading (growing current) → Download complete → Extracting → Pull complete
// Layers overlap in time, like a real `docker pull`.
function buildTimeline(): ScriptedEvent[] {
  const layers = [
    { id: 'a1b2c3d4e5f6', total: 209_715_200, startMs: 0, dlMs: 6000 }, // 200 MB
    { id: 'b2c3d4e5f6a1', total: 104_857_600, startMs: 1200, dlMs: 4500 }, // 100 MB
    { id: 'c3d4e5f6a1b2', total: 52_428_800, startMs: 2400, dlMs: 3000 }, // 50 MB
    { id: 'd4e5f6a1b2c3', total: 314_572_800, startMs: 800, dlMs: 8000 }, // 300 MB
  ];

  const script: ScriptedEvent[] = [];
  const DL_TICKS = 12; // download progress updates per layer
  const EXTRACT_MS = 2500;
  const EXTRACT_TICKS = 6;

  for (const layer of layers) {
    // Downloading — growing `current` toward `total`.
    for (let i = 1; i <= DL_TICKS; i++) {
      const frac = i / DL_TICKS;
      script.push({
        atMs: layer.startMs + Math.round((layer.dlMs * i) / DL_TICKS),
        event: {
          status: 'Downloading',
          id: layer.id,
          progressDetail: {
            current: Math.round(layer.total * frac),
            total: layer.total,
          },
        },
      });
    }
    const dlDone = layer.startMs + layer.dlMs;
    // Download complete.
    script.push({
      atMs: dlDone,
      event: { status: 'Download complete', id: layer.id },
    });
    // Extracting — growing current again.
    for (let i = 1; i <= EXTRACT_TICKS; i++) {
      const frac = i / EXTRACT_TICKS;
      script.push({
        atMs: dlDone + Math.round((EXTRACT_MS * i) / EXTRACT_TICKS),
        event: {
          status: 'Extracting',
          id: layer.id,
          progressDetail: {
            current: Math.round(layer.total * frac),
            total: layer.total,
          },
        },
      });
    }
    // Pull complete.
    script.push({
      atMs: dlDone + EXTRACT_MS,
      event: { status: 'Pull complete', id: layer.id },
    });
  }

  script.sort((a, b) => a.atMs - b.atMs);
  return script;
}

// Narration lines rotate as the pull proceeds (QC_plan §4.3).
const NARRATION = [
  'Downloading the track downloader — this is the component that fetches your music.',
  'Downloading the decryption service (wrapper) — this lets Audora talk securely to \u{1F34E} Music.',
  'Almost there — extracting downloaded files...',
  'This step only happens once. Future downloads will be instant.',
];

export default function LiveProgressPanelDemo() {
  // The "latest-per-layer" map the panel expects, collapsed by layer id.
  const [layerMap, setLayerMap] = useState<Record<string, PullEvent>>({});
  const [narration, setNarration] = useState<string>(NARRATION[0]);
  const [running, setRunning] = useState(true);
  const [tick, setTick] = useState(0); // used to restart

  const timelineRef = useRef<ScriptedEvent[]>([]);
  const idxRef = useRef(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (!running) return;

    // Fresh timeline on each (re)start.
    timelineRef.current = buildTimeline();
    idxRef.current = 0;
    startRef.current = Date.now();
    setLayerMap({});

    const interval = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const script = timelineRef.current;
      let applied = false;

      // Apply every scripted event whose time has arrived. Because we key the
      // panel's map by layer id, repeated events for the same layer UPDATE IN
      // PLACE rather than appending duplicates.
      while (idxRef.current < script.length && script[idxRef.current].atMs <= elapsed) {
        const { event } = script[idxRef.current];
        setLayerMap((prev) => ({ ...prev, [event.id ?? '__none__']: event }));
        idxRef.current++;
        applied = true;
      }

      // Rotate narration based on progress through the timeline.
      if (applied) {
        const p = idxRef.current / script.length;
        const n =
          p > 0.85 ? NARRATION[3] : p > 0.55 ? NARRATION[2] : p > 0.25 ? NARRATION[1] : NARRATION[0];
        setNarration(n);
      }

      if (idxRef.current >= script.length) {
        clearInterval(interval);
      }
    }, 250);

    return () => clearInterval(interval);
  }, [running, tick]);

  const layers = Object.values(layerMap);

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex items-center justify-center p-8 text-gray-100">
      <div className="w-full max-w-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">LiveProgressPanel — dev harness</h1>
            <p className="text-xs text-gray-500">
              Mock ws/setup event stream ({layers.length} layers). No backend running.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setRunning(false);
              // Restart on next frame with a fresh timeline.
              setTimeout(() => {
                setTick((t) => t + 1);
                setRunning(true);
              }, 50);
            }}
            className="bg-violet-600 hover:bg-violet-500 px-4 py-2 rounded-lg text-sm font-medium"
          >
            Replay
          </button>
        </div>

        <LiveProgressPanel layers={layers} narration={narration} />

        {/* Also show an empty-state instance to verify the "preparing" path. */}
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer hover:text-gray-300">
            Empty-state preview (no events)
          </summary>
          <div className="mt-3">
            <LiveProgressPanel layers={[]} />
          </div>
        </details>
      </div>
    </div>
  );
}
