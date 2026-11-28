package com.audora.mobile;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class LocalMedia {
    static final int ARTWORK_LIMIT = 8 * 1024 * 1024;
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
    private static final String HOST = Uri.parse(MainActivity.ORIGIN).getHost();
    private final Context context;

    LocalMedia(Context context) {
        this.context = context;
    }

    WebResourceResponse respond(WebResourceRequest request, String library, Map<String, AudioLibrary.Track> tracks) {
        Uri url = request.getUrl();
        if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost())
            || url.getPort() != -1 || !"GET".equals(request.getMethod())) {
            return empty(403, "Forbidden", new HashMap<>());
        }

        String path = url.getPath();
        if ("/library.json".equals(path)) {
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse("application/json", "UTF-8", 200, "OK", headers,
                new ByteArrayInputStream(library.getBytes(StandardCharsets.UTF_8)));
        }
        if ("/android.html".equals(path) || (path != null && path.matches("/assets/[A-Za-z0-9_.-]+"))) {
            return asset(path);
        }
        if (path != null && path.matches("/(tracks|covers)/[0-9a-f-]{36}")) {
            AudioLibrary.Track track = tracks.get(url.getLastPathSegment());
            if (track != null) {
                return path.startsWith("/covers/") ? cover(track) : stream(track, rangeHeader(request));
            }
        }
        return empty(404, "Not Found", new HashMap<>());
    }

    private WebResourceResponse asset(String path) {
        String suffix = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String mime;
        switch (suffix) {
            case "html": mime = "text/html"; break;
            case "js": mime = "application/javascript"; break;
            case "css": mime = "text/css"; break;
            case "png": mime = "image/png"; break;
            case "woff2": mime = "font/woff2"; break;
            default: return empty(404, "Not Found", new HashMap<>());
        }
        try {
            return new WebResourceResponse(mime, "UTF-8", context.getAssets().open(path.substring(1)));
        } catch (IOException error) {
            return empty(404, "Not Found", new HashMap<>());
        }
    }

    /** Reads the cover picture embedded in an audio file, or null when it has none. */
    static byte[] embeddedPicture(Context context, Uri uri) {
        try (InputStream header = context.getContentResolver().openInputStream(uri)) {
            if (header == null || MetadataSize.largestBlock(header) > ARTWORK_LIMIT) return null;
        } catch (IOException | RuntimeException unreadable) {
            return null;
        }
        MediaMetadataRetriever metadata = new MediaMetadataRetriever();
        try {
            metadata.setDataSource(context, uri);
            return metadata.getEmbeddedPicture();
        } catch (RuntimeException unavailable) {
            return null;
        } finally {
            try {
                metadata.release();
            } catch (IOException ignored) { }
        }
    }

    private WebResourceResponse cover(AudioLibrary.Track track) {
        byte[] bytes = embeddedPicture(context, track.uri);
        try {
            if (bytes != null && bytes.length <= ARTWORK_LIMIT) {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
                if (bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth <= 4096 && bounds.outHeight <= 4096
                    && ("image/jpeg".equals(bounds.outMimeType) || "image/png".equals(bounds.outMimeType)
                    || "image/webp".equals(bounds.outMimeType))) {
                    return new WebResourceResponse(bounds.outMimeType, null, new ByteArrayInputStream(bytes));
                }
            }
        } catch (RuntimeException error) {
            // An unavailable cover is handled by the library's fallback artwork.
        }
        return empty(404, "Not Found", new HashMap<>());
    }

    private static String rangeHeader(WebResourceRequest request) {
        for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
            if ("Range".equalsIgnoreCase(header.getKey())) return header.getValue();
        }
        return null;
    }

    private WebResourceResponse stream(AudioLibrary.Track track, String range) {
        AssetFileDescriptor descriptor = null;
        InputStream input = null;
        try {
            descriptor = context.getContentResolver().openAssetFileDescriptor(track.uri, "r");
            if (descriptor == null) return empty(404, "Not Found", new HashMap<>());
            long size = descriptor.getLength() >= 0 ? descriptor.getLength() : track.size;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            if (size >= 0) headers.put("Accept-Ranges", "bytes");
            long first = 0;
            long last = size - 1;
            boolean partial = range != null && size >= 0;
            if (partial) {
                Matcher match = RANGE.matcher(range);
                try {
                    if (!match.matches()) return invalidRange(size, descriptor);
                    if (match.group(1).isEmpty()) {
                        first = size - Math.min(size, Long.parseLong(match.group(2)));
                    } else {
                        first = Long.parseLong(match.group(1));
                        if (!match.group(2).isEmpty()) last = Math.min(last, Long.parseLong(match.group(2)));
                    }
                    if (first > last) return invalidRange(size, descriptor);
                } catch (NumberFormatException error) {
                    return invalidRange(size, descriptor);
                }
            }
            input = descriptor.createInputStream();
            long offset = first;
            while (offset > 0) {
                long skipped = input.skip(offset);
                if (skipped == 0) {
                    if (input.read() < 0) throw new IOException("Audio range is outside the file");
                    skipped = 1;
                }
                offset -= skipped;
            }
            if (size >= 0) {
                long length = last - first + 1;
                headers.put("Content-Length", Long.toString(length));
                input = new BoundedInput(input, length);
            }
            if (partial) headers.put("Content-Range", "bytes " + first + "-" + last + "/" + size);
            return new WebResourceResponse(track.mime, null, partial ? 206 : 200,
                partial ? "Partial Content" : "OK", headers, input);
        } catch (IOException | RuntimeException error) {
            try {
                if (input != null) input.close();
                else if (descriptor != null) descriptor.close();
            } catch (IOException ignored) { }
            return empty(404, "Not Found", new HashMap<>());
        }
    }

    private static WebResourceResponse invalidRange(long length, AssetFileDescriptor descriptor) throws IOException {
        descriptor.close();
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Range", "bytes */" + length);
        return empty(416, "Range Not Satisfiable", headers);
    }

    private static WebResourceResponse empty(int status, String reason, Map<String, String> headers) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason, headers, new ByteArrayInputStream(new byte[0]));
    }

    private static final class BoundedInput extends FilterInputStream {
        private long remaining;

        BoundedInput(InputStream stream, long remaining) {
            super(stream);
            this.remaining = remaining;
        }

        @Override public int read() throws IOException {
            if (remaining == 0) return -1;
            int value = in.read();
            if (value >= 0) remaining--;
            return value;
        }

        @Override public int read(byte[] buffer, int offset, int count) throws IOException {
            if (count == 0) return 0;
            if (remaining == 0) return -1;
            int read = in.read(buffer, offset, (int)Math.min(count, remaining));
            if (read > 0) remaining -= read;
            return read;
        }

        @Override public long skip(long amount) throws IOException {
            long skipped = in.skip(Math.min(amount, remaining));
            remaining -= skipped;
            return skipped;
        }
    }
}
