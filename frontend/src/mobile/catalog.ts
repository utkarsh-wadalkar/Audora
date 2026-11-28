export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  discNumber: number;
  trackNumber: number;
};

export type LibrarySnapshot = {
  folder: string;
  hasFolder: boolean;
  scanning: boolean;
  error: string;
  unreadableFolders: number;
  tracks: Track[];
};

export type Playlist = { id: string; name: string; tracks: string[] };
export type Collections = { favorites: string[]; playlists: Playlist[] };
export type Group = { id: string; name: string; artist?: string; tracks: Track[] };

const COLLECTION_KEY = 'audora.mobile.collections.v1';
const normalize = (value: string) => value.normalize().toLocaleLowerCase();
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function readCollections(): Collections {
  try {
    return JSON.parse(localStorage.getItem(COLLECTION_KEY) || 'null') ?? { favorites: [], playlists: [] };
  } catch {
    return { favorites: [], playlists: [] };
  }
}

export function writeCollections(collections: Collections) {
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(collections));
}

export function groupTracks(tracks: Track[], kind: 'Artists' | 'Albums'): Group[] {
  const groups = new Map<string, Group>();
  for (const track of tracks) {
    const artist = track.artist || 'Unknown artist';
    if (kind === 'Albums' && !track.album) continue;
    const name = kind === 'Artists' ? artist : track.album;
    const albumArtist = kind === 'Albums' ? track.albumArtist || track.artist : undefined;
    const id = JSON.stringify([normalize(name), normalize(albumArtist || '')]);
    let group = groups.get(id);
    if (!group) {
      group = { id, name, artist: albumArtist, tracks: [] };
      groups.set(id, group);
    }
    group.tracks.push(track);
  }
  if (kind === 'Albums') {
    for (const group of groups.values()) {
      group.tracks.sort((first, second) =>
        (first.discNumber || 1) - (second.discNumber || 1) ||
        (first.trackNumber || Infinity) - (second.trackNumber || Infinity) ||
        byName.compare(first.title, second.title));
    }
  }
  return [...groups.values()].sort((first, second) => byName.compare(first.name, second.name));
}

export function matches(query: string, ...fields: (string | undefined)[]) {
  const needle = normalize(query.trim());
  return fields.some((field) => normalize(field ?? '').includes(needle));
}
