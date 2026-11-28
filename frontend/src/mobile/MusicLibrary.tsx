import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Heart, ListMusic, MoreVertical, Play, Plus, X } from 'lucide-react';
import { fallbackCover } from '../lib/fallbackArtwork';
import { groupTracks, matches, readCollections, writeCollections } from './catalog';
import type { Group, LibrarySnapshot, Playlist, Track } from './catalog';

const tabs = ['Tracks', 'Artists', 'Albums', 'Playlists', 'Favorites'] as const;
type Tab = typeof tabs[number];
type Dialog = { kind: 'track'; track: Track } | { kind: 'name'; playlist?: Playlist; track?: Track } |
  { kind: 'delete'; playlist: Playlist };

export const button = 'min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-gray-100 disabled:opacity-50';
const iconButton = 'grid size-11 shrink-0 place-items-center rounded-xl text-gray-300';

function Cover({ track }: { track?: Track }) {
  const [failed, setFailed] = useState<string>();
  if (!track) return <ListMusic className="text-audora-300" size={20} />;
  return <img alt="" loading="lazy" className="size-full object-cover"
    src={failed === track.id ? fallbackCover(track.id) : '/covers/' + track.id} onError={() => setFailed(track.id)} />;
}

function Sheet({ children, title, close }: { children: ReactNode; title: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return <dialog ref={dialog} onCancel={close} aria-label={title}
    className="fixed inset-x-0 bottom-0 m-0 mt-auto max-h-[78vh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-white/15 bg-[#1b1724] p-4 text-gray-100 backdrop:bg-black/60">
    <header className="mb-3 flex items-center justify-between gap-3">
      <h2 className="min-w-0 break-words text-lg font-semibold">{title}</h2>
      <button aria-label="Close" className={iconButton} onClick={close}><X size={20} /></button>
    </header>
    {children}
  </dialog>;
}

export default function MusicLibrary({ library, onChoose, onRescan, onPlay }: {
  library: LibrarySnapshot;
  onChoose: () => void;
  onRescan: () => void;
  onPlay: (tracks: Track[], index: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('Tracks');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState('');
  const [dialog, setDialog] = useState<Dialog>();
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');
  const [collections, setCollections] = useState(readCollections);
  useEffect(() => { writeCollections(collections); }, [collections]);
  const indexed = useMemo(() => new Map(library.tracks.map((track) => [track.id, track])), [library.tracks]);
  const favorites = useMemo(() => new Set(collections.favorites), [collections.favorites]);
  const groups = useMemo(() => tab === 'Artists' || tab === 'Albums' ? groupTracks(library.tracks, tab) : [], [library.tracks, tab]);
  const playlist = tab === 'Playlists' ? collections.playlists.find((item) => item.id === selection) : undefined;
  const group = groups.find((item) => item.id === selection);
  const showingCollection = Boolean(group || playlist);

  const trackMatches = (track: Track) => matches(query, track.title, track.artist, track.album, track.albumArtist);
  const playlistTracks = (list: Playlist) => list.tracks.flatMap((id) => {
    const track = indexed.get(id);
    return track ? [track] : [];
  });
  const visibleTracks = (
    playlist ? playlistTracks(playlist) : group ? group.tracks :
      tab === 'Favorites' ? library.tracks.filter((track) => favorites.has(track.id)) :
      tab === 'Tracks' ? library.tracks : []
  ).filter(trackMatches);

  const navigate = (target: Tab, id = '') => {
    setTab(target);
    setSelection(id);
    setQuery('');
    setNotice('');
  };
  const toggleFavorite = (id: string) => setCollections((current) => ({
    ...current,
    favorites: current.favorites.includes(id) ? current.favorites.filter((item) => item !== id) : [...current.favorites, id],
  }));
  const editPlaylist = (id: string, edit: (list: Playlist) => Playlist) => setCollections((current) => ({
    ...current, playlists: current.playlists.map((list) => list.id === id ? edit(list) : list),
  }));
  const startName = (list?: Playlist, track?: Track) => {
    setName(list?.name ?? '');
    setDialog({ kind: 'name', playlist: list, track });
  };
  const closeDialog = () => setDialog(undefined);

  const savePlaylist = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== 'name' || !name.trim()) return;
    if (dialog.playlist) {
      editPlaylist(dialog.playlist.id, (list) => ({ ...list, name: name.trim() }));
    } else {
      const id = crypto.getRandomValues(new Uint32Array(4)).join('-');
      const list = { id, name: name.trim(), tracks: dialog.track ? [dialog.track.id] : [] };
      setCollections((current) => ({ ...current, playlists: [...current.playlists, list] }));
      navigate('Playlists', list.id);
    }
    closeDialog();
  };

  const moveTrack = (list: Playlist, id: string, direction: number) => {
    const available = playlistTracks(list);
    const index = available.findIndex((track) => track.id === id);
    const adjacent = available[index + direction];
    if (!adjacent) return;
    editPlaylist(list.id, (current) => {
      const ids = [...current.tracks];
      const origin = ids.indexOf(id);
      const destination = ids.indexOf(adjacent.id);
      if (origin < 0 || destination < 0) return current;
      ids[origin] = adjacent.id;
      ids[destination] = id;
      return { ...current, tracks: ids };
    });
  };

  const groupRow = (item: Group) => <li key={item.id}>
    <button onClick={() => navigate(tab, item.id)} className="flex w-full items-center gap-3 rounded-xl py-2 text-left">
      <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-white/5"><Cover track={item.tracks[0]} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.name}</span>
        <span className="block truncate text-sm text-gray-400">{item.artist && item.artist + ' · '}{item.tracks.length} {item.tracks.length === 1 ? 'track' : 'tracks'}</span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-gray-400" />
    </button>
  </li>;

  return <section aria-label="Music library" className="space-y-4">
    <header>
      <h1 className="text-2xl font-semibold">Music library</h1>
      <p aria-live="polite" className="mt-1 break-words text-sm text-gray-400">
        {library.scanning ? 'Scanning music…' : library.folder
          ? library.folder + ' · ' + library.tracks.length + (library.tracks.length === 1 ? ' track' : ' tracks')
          : 'Choose a folder containing your music.'}
      </p>
      {library.error && <p role="alert" className="mt-2 text-sm text-rose-300">{library.error}</p>}
      {library.unreadableFolders > 0 && <p className="mt-2 text-sm text-amber-200">Some subfolders couldn’t be read. Check their storage and rescan.</p>}
      <div className="mt-3 flex gap-2">
        <button className={button} disabled={library.scanning} onClick={onChoose}>{library.hasFolder ? 'Change music folder' : 'Choose music folder'}</button>
        {library.hasFolder && <button className={button} disabled={library.scanning} onClick={onRescan}>Rescan</button>}
      </div>
    </header>

    {library.hasFolder && <>
      <nav aria-label="Library views" className="flex gap-1 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-1">
        {tabs.map((name) => <button key={name} aria-pressed={tab === name} onClick={() => navigate(name)}
          className="min-h-[44px] shrink-0 rounded-lg px-3 text-sm text-gray-300 aria-pressed:bg-audora-400/20 aria-pressed:text-audora-100">{name}</button>)}
      </nav>
      <input type="search" aria-label="Search this library" placeholder="Search this library" value={query} onChange={(event) => setQuery(event.target.value)}
        className="min-h-[44px] w-full rounded-xl border border-white/10 bg-white/5 px-3 text-base" />
      {notice && <p role="status" className="text-sm text-audora-200">{notice}</p>}

      {(group || playlist) && <div className="flex flex-wrap items-center gap-2">
        <button className={iconButton} aria-label={'Back to ' + tab} onClick={() => navigate(tab)}><ArrowLeft size={19} /></button>
        <h2 className="min-w-0 flex-1 break-words text-xl font-semibold">{group?.name || playlist?.name}</h2>
        <button className={iconButton} aria-label="Play all tracks" disabled={!visibleTracks.length} onClick={() => onPlay(visibleTracks, 0)}><Play size={20} /></button>
        {playlist && <button className={iconButton} aria-label={'Options for ' + playlist.name} onClick={() => startName(playlist)}><MoreVertical size={20} /></button>}
      </div>}

      {!showingCollection && (tab === 'Artists' || tab === 'Albums') && <ul className="divide-y divide-white/10">
        {groups.filter((item) => matches(query, item.name, item.artist) || item.tracks.some(trackMatches)).map(groupRow)}
      </ul>}
      {!showingCollection && tab === 'Playlists' && <>
        <button className={button + ' inline-flex items-center gap-2'} onClick={() => startName()}><Plus size={17} /> New playlist</button>
        <ul className="divide-y divide-white/10">{collections.playlists.filter((item) => matches(query, item.name)).map((item) =>
          groupRow({ id: item.id, name: item.name, tracks: playlistTracks(item) }))}</ul>
      </>}

      {(tab === 'Tracks' || tab === 'Favorites' || group || playlist) && <>
        <ul className="divide-y divide-white/10">
          {visibleTracks.map((track, index) => <li key={track.id} className="flex items-center gap-1 py-1">
            <button className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 text-left" onClick={() => onPlay(visibleTracks, index)}>
              <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-white/5"><Cover track={track} /></span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{track.title}</span>
                <span className="block truncate text-sm text-gray-400">{[track.artist || 'Unknown artist', track.album].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
            <button aria-label={'Favorite ' + track.title} aria-pressed={favorites.has(track.id)}
              className={iconButton + ' aria-pressed:text-audora-300'} onClick={() => toggleFavorite(track.id)}><Heart size={19} fill={favorites.has(track.id) ? 'currentColor' : 'none'} /></button>
            <button aria-label={'Options for ' + track.title} className={iconButton} onClick={() => setDialog({ kind: 'track', track })}><MoreVertical size={19} /></button>
          </li>)}
        </ul>
        {!visibleTracks.length && !library.scanning && <p className="text-sm text-gray-400">
          {query.trim() ? 'No tracks match your search.' : playlist ? 'Add tracks from the library using the track’s options.' :
            tab === 'Favorites' ? 'Tap the heart beside a track to favorite it.' : 'No supported audio files were found.'}
        </p>}
        {playlist && playlist.tracks.length > playlistTracks(playlist).length &&
          <p className="text-sm text-gray-400">Some playlist tracks are outside the current library or unavailable.</p>}
      </>}
      {tab === 'Albums' && !showingCollection && !groups.length && !library.scanning &&
        <p className="text-sm text-gray-400">No album tags were found. These songs are available under Tracks.</p>}
    </>}

    {dialog?.kind === 'name' && <Sheet title={dialog.playlist ? 'Playlist options' : 'New playlist'} close={closeDialog}>
      <form onSubmit={savePlaylist} className="space-y-3">
        <label className="block text-sm">Playlist name
          <input className="mt-2 min-h-[44px] w-full rounded-xl border border-white/15 bg-black/20 px-3 text-base" autoFocus value={name}
            maxLength={100} required onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className={button + ' bg-audora-600'} disabled={!name.trim()} type="submit">{dialog.playlist ? 'Save name' : 'Create playlist'}</button>
          {dialog.playlist && <button className={button + ' text-rose-300'} type="button" onClick={() => {
            if (dialog.playlist) setDialog({ kind: 'delete', playlist: dialog.playlist });
          }}>Delete playlist</button>}
        </div>
      </form>
    </Sheet>}

    {dialog?.kind === 'delete' && <Sheet title={'Delete ' + dialog.playlist.name + '?'} close={closeDialog}>
      <p className="mb-4 text-sm text-gray-300">The music files stay in your library.</p>
      <button className={button + ' text-rose-300'} onClick={() => {
        setCollections((current) => ({ ...current, playlists: current.playlists.filter((item) => item.id !== dialog.playlist.id) }));
        closeDialog();
        navigate('Playlists');
      }}>Delete playlist</button>
    </Sheet>}

    {dialog?.kind === 'track' && <Sheet title={dialog.track.title} close={closeDialog}>
      <div className="flex flex-wrap gap-2">
        {playlist && <>
          <button aria-label="Move track up" className={iconButton} onClick={() => moveTrack(playlist, dialog.track.id, -1)}><ArrowUp size={18} /></button>
          <button aria-label="Move track down" className={iconButton} onClick={() => moveTrack(playlist, dialog.track.id, 1)}><ArrowDown size={18} /></button>
          <button className={button} onClick={() => {
            editPlaylist(playlist.id, (item) => ({ ...item, tracks: item.tracks.filter((id) => id !== dialog.track.id) }));
            closeDialog();
          }}>Remove from playlist</button>
        </>}
      </div>
      <h3 className="mb-2 mt-3 text-sm font-medium">Add to playlist</h3>
      <div className="grid gap-2">
        {collections.playlists.map((item) => <button key={item.id} className={button + ' text-left'} disabled={item.tracks.includes(dialog.track.id)} onClick={() => {
          editPlaylist(item.id, (list) => ({ ...list, tracks: [...list.tracks, dialog.track.id] }));
          setNotice('Added to ' + item.name + '.');
          closeDialog();
        }}>{item.name}{item.tracks.includes(dialog.track.id) ? ' · Added' : ''}</button>)}
        <button className={button + ' text-left'} onClick={() => startName(undefined, dialog.track)}>New playlist</button>
      </div>
    </Sheet>}
  </section>;
}
