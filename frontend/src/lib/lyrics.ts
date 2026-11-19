export interface TimedLyric { seconds: number; text: string }

export function parseLrc(raw: string): TimedLyric[] {
  const lines: TimedLyric[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
    for (const tag of tags) lines.push({ seconds: Number(tag[1]) * 60 + Number(tag[2]), text });
  }
  return lines.sort((a, b) => a.seconds - b.seconds);
}
