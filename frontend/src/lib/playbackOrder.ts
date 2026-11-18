/** Shuffle only songs that have not played yet, keeping the current song and history in place. */
export function shuffleUpcoming<T>(items: T[], currentIndex: number, random = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > currentIndex + 1; index--) {
    const swap = currentIndex + 1 + Math.floor(random() * (index - currentIndex));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/** Restore library order for upcoming songs without changing playback history. */
export function restoreUpcoming<T>(
  items: T[], original: T[], currentIndex: number,
  same: (first: T, second: T) => boolean = (first, second) => first === second,
): T[] {
  const history = items.slice(0, currentIndex + 1);
  const remaining = items.slice(currentIndex + 1);
  const originalRemaining = [...original];
  for (const played of history) {
    const index = originalRemaining.findIndex((item) => same(item, played));
    if (index >= 0) originalRemaining.splice(index, 1);
  }
  const ordered: T[] = [];
  for (const item of originalRemaining) {
    const index = remaining.findIndex((candidate) => same(candidate, item));
    if (index >= 0) ordered.push(...remaining.splice(index, 1));
  }
  return [...history, ...ordered, ...remaining];
}
