package com.audora.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.media.MediaRouter2;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int OPEN_FOLDER = 1;
    private static final int NOTIFICATIONS = 2;
    private static final int READ = Intent.FLAG_GRANT_READ_URI_PERMISSION;

    private final ExecutorService scanner = Executors.newSingleThreadExecutor();
    private volatile String library = "{}";
    private volatile Map<String, AudioLibrary.Track> tracks = new HashMap<>();
    private final BroadcastReceiver unplugged = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            emit("audora-headphones-unplugged");
        }
    };
    private final ServiceConnection playbackConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            playback = ((PlaybackService.LocalBinder)service).service();
            playback.connect(transport);
            if (pendingNowPlaying != null) playback.update(pendingNowPlaying);
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            playback = null;
        }
    };
    private final PlaybackService.Controls transport = new PlaybackService.Controls() {
        @Override public void play() { dispatch("play"); }
        @Override public void pause() { dispatch("pause"); }
        @Override public void next() { dispatch("next"); }
        @Override public void previous() { dispatch("previous"); }
        @Override public void stop() { dispatch("stop"); }
        @Override public void seek(long positionMs) { dispatch("seek:" + positionMs); }
    };
    private PlaybackService playback;
    private PlaybackService.NowPlaying pendingNowPlaying;
    private SharedPreferences preferences;
    private WebView web;
    private Uri tree;
    private String folderName = "";
    private JSONArray catalog = new JSONArray();
    private int unreadableFolders;
    private boolean busy;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        preferences = getSharedPreferences("library", MODE_PRIVATE);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(0xff100f15);
        FrameLayout content = new FrameLayout(this);
        content.setBackgroundColor(0xff100f15);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                int bottom = Math.max(bars.bottom, insets.getInsets(WindowInsets.Type.ime()).bottom);
                view.setPadding(bars.left, bars.top, bars.right, bottom);
            }
            return insets;
        });
        LocalMedia localMedia = new LocalMedia(this);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return localMedia.respond(request, library, tracks);
            }
        });
        web.addJavascriptInterface(new LibraryActions(), "AudoraAndroid");
        setContentView(content);
        IntentFilter headphones = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        // This system broadcast can originate from a privileged process outside the app.
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(unplugged, headphones, RECEIVER_EXPORTED);
        else registerReceiver(unplugged, headphones);
        bindService(new Intent(this, PlaybackService.class), playbackConnection, BIND_AUTO_CREATE);
        tree = readFolder();
        if (tree != null) {
            scan(tree);
            inviteNotifications();
        } else {
            publish("");
        }
        web.loadUrl(ORIGIN + "/android.html");
    }

    private final class LibraryActions {
        @JavascriptInterface public void chooseFolder() { runOnUiThread(MainActivity.this::chooseFolder); }
        @JavascriptInterface public void rescan() {
            runOnUiThread(() -> { if (!busy && tree != null) scan(tree); });
        }
        @JavascriptInterface public void nowPlaying(String track) {
            PlaybackService.NowPlaying next = readNowPlaying(track);
            if (next == null) return;
            runOnUiThread(() -> {
                pendingNowPlaying = next;
                if (playback != null) playback.update(next);
            });
        }
        @JavascriptInterface public void playbackStopped() {
            runOnUiThread(() -> {
                pendingNowPlaying = null;
                if (playback != null) playback.clear();
            });
        }
        @JavascriptInterface public void audioOutput() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 34 && MediaRouter2.getInstance(MainActivity.this).showSystemOutputSwitcher()) return;
                try {
                    startActivity(new Intent(Settings.ACTION_SOUND_SETTINGS));
                } catch (android.content.ActivityNotFoundException error) {
                    emit("audora-output-unavailable");
                }
            });
        }
    }

    private PlaybackService.NowPlaying readNowPlaying(String track) {
        try {
            JSONObject fields = new JSONObject(track);
            String id = fields.getString("id");
            AudioLibrary.Track known = tracks.get(id);
            return new PlaybackService.NowPlaying(
                id, known == null ? null : known.uri,
                fields.optString("title", "Untitled track"),
                fields.optString("artist", ""),
                fields.optString("album", ""),
                Math.round(fields.optDouble("duration", 0) * 1000),
                Math.round(fields.optDouble("position", 0) * 1000),
                fields.optBoolean("playing"),
                fields.optBoolean("hasPrevious"),
                fields.optBoolean("hasNext"));
        } catch (JSONException malformed) {
            return null;
        }
    }

    /**
     * Asks for the playback notification while the listener sets up their music folder, so the
     * notification and lock screen controls are ready before the first track plays.
     */
    private void inviteNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        // Android stops showing the prompt once it is declined, so asking again would do nothing.
        if (shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATIONS);
    }

    private void dispatch(String command) {
        if (web == null) return;
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('audora-transport',{detail:"
            + JSONObject.quote(command) + "}))", null);
    }

    private Uri readFolder() {
        String saved = preferences.getString("folder", null);
        return saved == null ? null : Uri.parse(saved);
    }

    private void chooseFolder() {
        if (busy) return;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(READ | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        if (tree != null) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, tree);
        try {
            startActivityForResult(intent, OPEN_FOLDER);
        } catch (android.content.ActivityNotFoundException error) {
            publish("This device has no file picker. Enable the system Files app and try again.");
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != OPEN_FOLDER || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri selected = data.getData();
        try {
            getContentResolver().takePersistableUriPermission(selected, READ);
            scan(selected);
            inviteNotifications();
        } catch (SecurityException error) {
            publish("Android couldn’t save access to that folder. Choose a local music folder and try again.");
        }
    }

    private void scan(Uri selected) {
        busy = true;
        publish("");
        scanner.submit(() -> {
            try {
                AudioLibrary.Result result = AudioLibrary.scan(this, selected);
                Map<String, AudioLibrary.Track> indexed = new HashMap<>();
                JSONArray rows = new JSONArray();
                for (AudioLibrary.Track track : result.tracks) {
                    indexed.put(track.id, track);
                    rows.put(new JSONObject().put("id", track.id).put("title", track.title)
                        .put("artist", track.artist).put("album", track.album).put("albumArtist", track.albumArtist)
                        .put("discNumber", track.discNumber).put("trackNumber", track.trackNumber));
                }
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    if (tree != null && !tree.equals(selected)) releaseFolder(tree);
                    tree = selected;
                    preferences.edit().putString("folder", selected.toString()).apply();
                    tracks = indexed;
                    catalog = rows;
                    folderName = result.folder;
                    unreadableFolders = result.unreadableFolders;
                    busy = false;
                    publish("");
                });
            } catch (IOException | JSONException | RuntimeException error) {
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    if (!selected.equals(tree)) releaseFolder(selected);
                    busy = false;
                    publish("Couldn’t read the folder. Reconnect its storage or choose another music folder.");
                });
            }
        });
    }

    private void releaseFolder(Uri folder) {
        try {
            getContentResolver().releasePersistableUriPermission(folder, READ);
        } catch (SecurityException ignored) { }
    }

    private void publish(String error) {
        try {
            library = new JSONObject().put("folder", folderName).put("hasFolder", tree != null)
                .put("scanning", busy).put("error", error).put("unreadableFolders", unreadableFolders)
                .put("tracks", catalog).toString();
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        emit("audora-library");
    }

    private void emit(String signal) {
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event(" + JSONObject.quote(signal) + "))", null);
    }

    @Override protected void onDestroy() {
        if (playback != null) {
            playback.clear();
            playback.connect(null);
            playback = null;
        }
        unbindService(playbackConnection);
        unregisterReceiver(unplugged);
        scanner.shutdownNow();
        if (web != null) {
            web.removeJavascriptInterface("AudoraAndroid");
            setContentView(new android.view.View(this));
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
