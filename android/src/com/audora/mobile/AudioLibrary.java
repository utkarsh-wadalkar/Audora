package com.audora.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.DocumentsContract;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.Collator;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

import static android.provider.DocumentsContract.Document.*;

final class AudioLibrary {
    private static final String[] COLUMNS = {COLUMN_DOCUMENT_ID, COLUMN_DISPLAY_NAME, COLUMN_MIME_TYPE, COLUMN_SIZE};
    private static final Set<String> AUDIO_EXTENSIONS = new HashSet<>(Arrays.asList(
        "flac", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "mp4"
    ));

    static final class Track {
        final Uri uri;
        final String id;
        final String title;
        final String artist;
        final String album;
        final String albumArtist;
        final int discNumber;
        final int trackNumber;
        final String mime;
        final long size;

        Track(Uri uri, String mime, long size, String title, String artist, String album,
              String albumArtist, int discNumber, int trackNumber) {
            this.uri = uri;
            this.id = UUID.nameUUIDFromBytes(uri.toString().getBytes(StandardCharsets.UTF_8)).toString();
            this.mime = mime;
            this.size = size;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.albumArtist = albumArtist;
            this.discNumber = discNumber;
            this.trackNumber = trackNumber;
        }
    }

    static final class Result {
        final String folder;
        final List<Track> tracks;
        final int unreadableFolders;

        Result(String folder, List<Track> tracks, int unreadableFolders) {
            this.folder = folder;
            this.tracks = tracks;
            this.unreadableFolders = unreadableFolders;
        }
    }

    static Result scan(Context context, Uri tree) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String root = DocumentsContract.getTreeDocumentId(tree);
        Uri rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, root);
        String folder = "Music folder";
        try (Cursor cursor = resolver.query(rootUri, new String[]{COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new IOException("Music folder unavailable");
            if (cursor.getString(0) != null) folder = cursor.getString(0);
        }

        List<Track> tracks = new ArrayList<>();
        ArrayDeque<String> folders = new ArrayDeque<>();
        Set<String> visited = new HashSet<>();
        folders.add(root);
        int unreadable = 0;
        while (!folders.isEmpty()) {
            checkInterrupted();
            String directory = folders.removeFirst();
            if (!visited.add(directory)) continue;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, directory);
            try (Cursor cursor = resolver.query(children, COLUMNS, null, null, null)) {
                if (cursor == null) throw new IOException("Folder unavailable");
                while (cursor.moveToNext()) {
                    checkInterrupted();
                    String id = cursor.getString(0);
                    String name = cursor.getString(1);
                    String type = cursor.getString(2);
                    if (id == null) continue;
                    if (MIME_TYPE_DIR.equals(type)) {
                        folders.addLast(id);
                    } else if (isAudio(name, type) && visited.add(id)) {
                        tracks.add(readTrack(context, DocumentsContract.buildDocumentUriUsingTree(tree, id),
                            name, type, cursor.isNull(3) ? -1 : cursor.getLong(3)));
                    }
                }
            } catch (SecurityException | IllegalArgumentException error) {
                if (directory.equals(root)) throw error;
                unreadable++;
            } catch (IOException error) {
                if (directory.equals(root) || Thread.currentThread().isInterrupted()) throw error;
                unreadable++;
            }
        }
        Collator names = Collator.getInstance();
        names.setStrength(Collator.PRIMARY);
        tracks.sort((first, second) -> names.compare(first.title, second.title));
        return new Result(folder, tracks, unreadable);
    }

    private static void checkInterrupted() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Scan interrupted");
    }

    private static boolean isAudio(String name, String type) {
        if (type != null && type.startsWith("audio/")) return true;
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        return dot >= 0 && AUDIO_EXTENSIONS.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    private static Track readTrack(Context context, Uri uri, String name, String type, long size) {
        String fallback = name == null ? "Untitled track" : name.replaceFirst("\\.[^.]+$", "");
        String mime = mimeType(name, type);
        MediaMetadataRetriever metadata = new MediaMetadataRetriever();
        try {
            metadata.setDataSource(context, uri);
            return new Track(
                uri, mime, size,
                tag(metadata, MediaMetadataRetriever.METADATA_KEY_TITLE, fallback),
                tag(metadata, MediaMetadataRetriever.METADATA_KEY_ARTIST, ""),
                tag(metadata, MediaMetadataRetriever.METADATA_KEY_ALBUM, ""),
                tag(metadata, MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST, ""),
                numberTag(metadata, MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER),
                numberTag(metadata, MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)
            );
        } catch (RuntimeException unavailable) {
            return new Track(uri, mime, size, fallback, "", "", "", 0, 0);
        } finally {
            try {
                metadata.release();
            } catch (IOException ignored) {
                // The file provider may close its descriptor before release.
            }
        }
    }

    private static String tag(MediaMetadataRetriever metadata, int key, String fallback) {
        String value = metadata.extractMetadata(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private static int numberTag(MediaMetadataRetriever metadata, int key) {
        String value = tag(metadata, key, "");
        try {
            return Math.max(0, Integer.parseInt(value.split("/", 2)[0].trim()));
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    private static String mimeType(String name, String type) {
        if (name != null) {
            String lower = name.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".flac")) return "audio/flac";
            if (lower.endsWith(".wav")) return "audio/wav";
            if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
            if (lower.endsWith(".mp3")) return "audio/mpeg";
            if (lower.endsWith(".opus") || lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
        }
        return type != null && type.startsWith("audio/") ? type : "application/octet-stream";
    }
}
