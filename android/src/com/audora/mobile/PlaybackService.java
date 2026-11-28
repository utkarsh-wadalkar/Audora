package com.audora.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Publishes the web player's track to Android's media notification and lock screen controls. */
public final class PlaybackService extends Service {
    /** Transport commands that the notification, lock screen, and headset buttons send back to the player. */
    interface Controls {
        void play();
        void pause();
        void next();
        void previous();
        void stop();
        void seek(long positionMs);
    }

    /** The whole state Android needs to render playback, sent as one value on every change. */
    static final class NowPlaying {
        final String id;
        final Uri uri;
        final String title;
        final String artist;
        final String album;
        final long durationMs;
        final long positionMs;
        final boolean playing;
        final boolean hasPrevious;
        final boolean hasNext;

        NowPlaying(String id, Uri uri, String title, String artist, String album, long durationMs,
                   long positionMs, boolean playing, boolean hasPrevious, boolean hasNext) {
            this.id = id;
            this.uri = uri;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.durationMs = durationMs;
            this.positionMs = positionMs;
            this.playing = playing;
            this.hasPrevious = hasPrevious;
            this.hasNext = hasNext;
        }
    }

    final class LocalBinder extends Binder {
        PlaybackService service() {
            return PlaybackService.this;
        }
    }

    private static final String CHANNEL = "audora.playback";
    private static final int NOTIFICATION = 1;
    private static final String PLAY = "com.audora.mobile.action.PLAY";
    private static final String PAUSE = "com.audora.mobile.action.PAUSE";
    private static final String NEXT = "com.audora.mobile.action.NEXT";
    private static final String PREVIOUS = "com.audora.mobile.action.PREVIOUS";
    private static final String STOP = "com.audora.mobile.action.STOP";
    private static final String[] BUTTONS = {PLAY, PAUSE, NEXT, PREVIOUS, STOP};
    private static final long ALWAYS = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP;
    private static final int ARTWORK_EDGE = 512;
    private static final int ARTWORK_LIMIT = 8 * 1024 * 1024;

    private final LocalBinder binder = new LocalBinder();
    private final ExecutorService artworkLoader = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BroadcastReceiver buttons = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            command(intent.getAction());
        }
    };
    private NotificationManager notifications;
    private MediaSession session;
    private Controls controls;
    private NowPlaying state;
    private String artworkTrack;
    private Bitmap artwork;
    private boolean foreground;

    @Override public void onCreate() {
        super.onCreate();
        notifications = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        notifications.createNotificationChannel(channel);
        session = new MediaSession(this, "Audora");
        session.setSessionActivity(openApp());
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { command(PLAY); }
            @Override public void onPause() { command(PAUSE); }
            @Override public void onSkipToNext() { command(NEXT); }
            @Override public void onSkipToPrevious() { command(PREVIOUS); }
            @Override public void onStop() { command(STOP); }
            @Override public void onSeekTo(long position) {
                main.post(() -> { if (controls != null) controls.seek(position); });
            }
        });
        IntentFilter filter = new IntentFilter();
        for (String button : BUTTONS) filter.addAction(button);
        // Only this app's notification buttons send these, so the receiver stays unexported.
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(buttons, filter, RECEIVER_NOT_EXPORTED);
        else registerReceiver(buttons, filter);
    }

    @Override public IBinder onBind(Intent intent) {
        return binder;
    }

    void connect(Controls player) {
        controls = player;
    }

    void update(NowPlaying next) {
        state = next;
        if (!next.id.equals(artworkTrack)) {
            artworkTrack = next.id;
            artwork = null;
            loadArtwork(next);
        }
        session.setActive(true);
        session.setMetadata(metadata(next));
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(ALWAYS
                | (next.hasPrevious ? PlaybackState.ACTION_SKIP_TO_PREVIOUS : 0)
                | (next.hasNext ? PlaybackState.ACTION_SKIP_TO_NEXT : 0))
            .setState(next.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                next.positionMs, next.playing ? 1f : 0f)
            .build());
        post(next);
    }

    void clear() {
        state = null;
        artworkTrack = null;
        artwork = null;
        session.setPlaybackState(new PlaybackState.Builder()
            .setState(PlaybackState.STATE_STOPPED, 0, 0f).build());
        session.setActive(false);
        stopForeground(STOP_FOREGROUND_REMOVE);
        foreground = false;
        notifications.cancel(NOTIFICATION);
    }

    private void command(String action) {
        main.post(() -> {
            if (controls == null || action == null) return;
            switch (action) {
                case PLAY: controls.play(); break;
                case PAUSE: controls.pause(); break;
                case NEXT: controls.next(); break;
                case PREVIOUS: controls.previous(); break;
                case STOP: controls.stop(); break;
                default: break;
            }
        });
    }

    private void post(NowPlaying track) {
        Notification notification = notification(track);
        if (!track.playing) {
            if (foreground) {
                stopForeground(STOP_FOREGROUND_DETACH);
                foreground = false;
            }
            notifications.notify(NOTIFICATION, notification);
            return;
        }
        if (foreground) {
            notifications.notify(NOTIFICATION, notification);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION, notification);
            }
            foreground = true;
        } catch (RuntimeException restricted) {
            // Android can refuse a foreground start from the background; the notification still shows.
            notifications.notify(NOTIFICATION, notification);
        }
    }

    private Notification notification(NowPlaying track) {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.audora_status)
            .setContentTitle(track.title)
            .setContentText(track.artist.isEmpty() ? track.album : track.artist)
            .setLargeIcon(artwork)
            .setContentIntent(openApp())
            .setDeleteIntent(button(STOP))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(false)
            .setOngoing(track.playing)
            .setColor(0xffa894e2)
            .setColorized(true);
        builder.addAction(action(android.R.drawable.ic_media_previous, "Previous track",
            track.hasPrevious ? button(PREVIOUS) : null));
        builder.addAction(track.playing
            ? action(android.R.drawable.ic_media_pause, "Pause", button(PAUSE))
            : action(android.R.drawable.ic_media_play, "Play", button(PLAY)));
        builder.addAction(action(android.R.drawable.ic_media_next, "Next track",
            track.hasNext ? button(NEXT) : null));
        builder.setStyle(new Notification.MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2));
        return builder.build();
    }

    private MediaMetadata metadata(NowPlaying track) {
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, track.title)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, track.title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, track.artist)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, track.artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, track.album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, track.durationMs > 0 ? track.durationMs : -1);
        if (artwork != null) builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        return builder.build();
    }

    private Notification.Action action(int icon, String title, PendingIntent intent) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, intent).build();
    }

    private PendingIntent button(String action) {
        Intent intent = new Intent(action).setPackage(getPackageName());
        return PendingIntent.getBroadcast(this, action.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    private void loadArtwork(NowPlaying track) {
        String id = track.id;
        Uri uri = track.uri;
        if (uri == null) return;
        artworkLoader.execute(() -> {
            Bitmap cover = decode(LocalMedia.embeddedPicture(this, uri));
            if (cover == null) return;
            main.post(() -> {
                if (!id.equals(artworkTrack) || state == null) return;
                artwork = cover;
                session.setMetadata(metadata(state));
                post(state);
            });
        });
    }

    private static Bitmap decode(byte[] picture) {
        if (picture == null || picture.length == 0 || picture.length > ARTWORK_LIMIT) return null;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(picture, 0, picture.length, bounds);
            BitmapFactory.Options options = new BitmapFactory.Options();
            int edge = Math.max(bounds.outWidth, bounds.outHeight);
            options.inSampleSize = Math.max(1, Integer.highestOneBit(edge / ARTWORK_EDGE));
            return BitmapFactory.decodeByteArray(picture, 0, picture.length, options);
        } catch (RuntimeException | OutOfMemoryError unreadable) {
            return null;
        }
    }

    @Override public void onDestroy() {
        clear();
        unregisterReceiver(buttons);
        controls = null;
        session.release();
        artworkLoader.shutdownNow();
        super.onDestroy();
    }
}
