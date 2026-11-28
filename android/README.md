# Audora for Android

Audora for Android plays music from a folder you choose through Android's system picker. It remembers the folder, scans subfolders, and uses embedded tags for the Artists and Albums views. Favorites and playlists are stored on the phone. Playlists can be renamed, reordered, and edited without changing the music files.

Android uses the desktop effects engine and a compact equalizer with preamp and ten fixed-frequency sliders. Compressor, spatializer, stereo widening, and the Advanced effects use the shared controls. Audio output opens Android's system output controls. Effects, playback formats, and pitch processing depend on the installed Android System WebView.

This is a standalone local player. Its APK has no network or all-files storage permission. Apple Music downloads, Docker, and the desktop setup wizard are outside the Android app.

## Build

Use PowerShell 7, Node.js, JDK 17, Android SDK Platform 35, and Build Tools 35.0.0. Install the existing frontend dependencies with `npm ci` in `frontend`. From the repository root, pass the installed tool paths to the build script.

```powershell
./android/build.ps1 -JavaHome $env:JAVA_HOME -BuildTools (Join-Path $env:ANDROID_HOME 'build-tools/35.0.0') -AndroidJar (Join-Path $env:ANDROID_HOME 'platforms/android-35/android.jar')
```

The script combines the desktop version with an Android revision and writes an installable QA-signed APK to `.cache/BUILD/android`. Android 8.0 or newer is required. Keep Android System WebView up to date.

For distribution, set `AUDORA_ANDROID_KEYSTORE_PASSWORD` and supply your signing store with `-Keystore` and `-KeyAlias`. Set `AUDORA_ANDROID_KEY_PASSWORD` when the signing key uses a separate password. Keep signing credentials outside the repository. Android updates require the same application ID and signing identity.
