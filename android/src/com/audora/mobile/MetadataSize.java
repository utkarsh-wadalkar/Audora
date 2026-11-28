package com.audora.mobile;

import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;

/**
 * Finds the largest metadata block in an audio file by reading container headers only.
 * MediaMetadataRetriever copies the whole embedded picture into memory before callers can
 * check its size, so artwork is read only when this bound is small enough.
 */
final class MetadataSize {
    static final long UNKNOWN = Long.MAX_VALUE;
    private static final int MAX_BLOCKS = 4096;

    private MetadataSize() { }

    /** Returns the size of the largest block that can hold artwork, 0 when none exists, or UNKNOWN. */
    static long largestBlock(InputStream input) throws IOException {
        DataInputStream in = new DataInputStream(input);
        byte[] magic = new byte[4];
        try {
            in.readFully(magic);
        } catch (EOFException empty) {
            return 0;
        }
        return largestBlock(in, magic);
    }

    private static long largestBlock(DataInputStream in, byte[] magic) throws IOException {
        if (magic[0] == 'I' && magic[1] == 'D' && magic[2] == '3') return id3(in, magic);
        if (is(magic, "fLaC")) return flac(in);
        if (is(magic, "OggS")) return ogg(in);
        if (is(magic, "RIFF")) return riff(in);
        if ((magic[0] & 0xff) == 0xff && (magic[1] & 0xe0) == 0xe0) return 0; // Bare MPEG or ADTS frames.
        return mp4(in, magic);
    }

    private static long id3(DataInputStream in, byte[] magic) throws IOException {
        in.readUnsignedByte(); // The magic bytes already include the major version; this is the revision.
        int flags = in.readUnsignedByte();
        long size = 0;
        for (int i = 0; i < 4; i++) size = (size << 7) | (in.readUnsignedByte() & 0x7f);
        long tag = size + ((flags & 0x10) != 0 ? 10 : 0);
        skip(in, tag);
        byte[] next = new byte[4];
        try {
            in.readFully(next);
        } catch (EOFException end) {
            return tag;
        }
        return Math.max(tag, largestBlock(in, next));
    }

    private static long flac(DataInputStream in) throws IOException {
        long largest = 0;
        for (int block = 0; block < MAX_BLOCKS; block++) {
            int header = in.readInt();
            long length = header & 0xffffff;
            largest = Math.max(largest, length);
            if (header < 0) return largest; // The top bit marks the last metadata block.
            skip(in, length);
        }
        return UNKNOWN;
    }

    /** The second Ogg packet holds the Vorbis or Opus comments, including any embedded picture. */
    private static long ogg(DataInputStream in) throws IOException {
        int packet = 0;
        long comments = 0;
        for (int page = 0; page < MAX_BLOCKS; page++) {
            if (page > 0) {
                byte[] capture = new byte[4];
                in.readFully(capture);
                if (!is(capture, "OggS")) return UNKNOWN;
            }
            skip(in, 22);
            int segments = in.readUnsignedByte();
            int[] lacing = new int[segments];
            long body = 0;
            for (int i = 0; i < segments; i++) body += lacing[i] = in.readUnsignedByte();
            for (int value : lacing) {
                if (packet == 1) comments += value;
                if (value < 255 && packet++ == 1) return comments;
            }
            skip(in, body);
        }
        return UNKNOWN;
    }

    private static long riff(DataInputStream in) throws IOException {
        skip(in, 8);
        long largest = 0;
        byte[] id = new byte[4];
        for (int chunk = 0; chunk < MAX_BLOCKS; chunk++) {
            try {
                in.readFully(id);
            } catch (EOFException end) {
                return largest;
            }
            long length = Integer.reverseBytes(in.readInt()) & 0xffffffffL;
            if (!is(id, "data")) largest = Math.max(largest, length);
            skip(in, length + (length & 1));
        }
        return UNKNOWN;
    }

    /** MP4 keeps all tags, including cover art, inside the top-level moov box. */
    private static long mp4(DataInputStream in, byte[] firstSize) throws IOException {
        long size = readUnsigned(firstSize);
        byte[] type = new byte[4];
        in.readFully(type);
        if (!is(type, "ftyp")) return UNKNOWN;
        for (int box = 0; box < MAX_BLOCKS; box++) {
            long header = 8;
            if (size == 1) {
                size = in.readLong();
                header = 16;
            }
            if (size == 0 || size < header) return UNKNOWN;
            if (is(type, "moov")) return size;
            skip(in, size - header);
            byte[] next = new byte[4];
            try {
                in.readFully(next);
            } catch (EOFException end) {
                return 0;
            }
            size = readUnsigned(next);
            in.readFully(type);
        }
        return UNKNOWN;
    }

    private static long readUnsigned(byte[] bytes) {
        return ((bytes[0] & 0xffL) << 24) | ((bytes[1] & 0xffL) << 16) | ((bytes[2] & 0xffL) << 8) | (bytes[3] & 0xffL);
    }

    private static boolean is(byte[] bytes, String text) {
        for (int i = 0; i < 4; i++) if (bytes[i] != text.charAt(i)) return false;
        return true;
    }

    private static void skip(InputStream in, long count) throws IOException {
        while (count > 0) {
            long skipped = in.skip(count);
            if (skipped <= 0) {
                if (in.read() < 0) throw new EOFException();
                skipped = 1;
            }
            count -= skipped;
        }
    }
}
