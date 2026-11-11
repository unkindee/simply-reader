# Simply Reader for Android

The Android version wraps the desktop app's reader (`src/renderer/`) and book engine (`vendor/foliate-js/`) in a [Capacitor](https://capacitorjs.com/) shell. The interface is the same code as on desktop; only `window.api` (the bridge that `src/preload.js` and `src/main.js` provide on desktop) is reimplemented for Android.

It's sideloaded as an APK. There's no Play Store listing, account, server or sync.

## What's here

| Path | Role |
|---|---|
| `package.json` | The Android build's own dependencies (Capacitor), kept apart from the desktop app's |
| `capacitor.config.json` | App id `io.github.unkindee.simplyreader`; starts at `/src/renderer/index.html` |
| `scripts/prepare-web.mjs` | Builds `www/` (git-ignored) from the shared renderer: adds the Content-Security-Policy `<meta>` tag and loads the adapter before `app.js` |
| `web/api.js` | `window.api` for Android, on top of the native plugin. Uses the rules shared with desktop (`src/shared/rules.mjs`) |
| `android/` | The native project. `app/src/main/java/io/github/unkindee/simplyreader/` holds the plugin (`SimplyReaderPlugin`), book import, durable writes, ZIP and network code, and `MainActivity` (WebView restrictions) |
| `test/api.test.mjs` | Runs `web/api.js` in Node against a fake plugin (desktop's `src/zip.js` writes and reads the archives) |
| `test/make-fixtures.mjs` | Writes a synthetic test EPUB, including hostile content that must never run |

## Building

GitHub Actions builds the APK on every push to the `android` branch (`.github/workflows/android.yml`) and attaches it to the run as the `simply-reader-android` artifact:

```
gh run list --branch android
gh run download <run id> --dir apk
```

To build locally you need Node 22+, JDK 21 and the Android SDK (platform 36). Android Studio includes the last two; the command-line tools are enough.

```
cd mobile
npm ci
npm test                         # adapter tests (no SDK needed)
npm run sync                     # www/ + cap sync
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

The version comes from the root `package.json`: `versionName` is the version and `versionCode` is `major*10000 + minor*100 + patch`. An update must have a higher `versionCode` and the same signing key as the version it replaces, or Android won't install it over the old one.

### Release signing

Release builds are signed with a key that's never in the repository. Create it once, keep two backups and its password in a password manager: losing it means users have to uninstall (which deletes their library) to install a newer version.

```
keytool -genkeypair -v -keystore simply-reader.keystore -alias simplyreader -keyalg RSA -keysize 4096 -validity 36500
```

Locally: set `SR_KEYSTORE` (path), `SR_KEYSTORE_PASSWORD`, `SR_KEY_ALIAS` and `SR_KEY_PASSWORD`, then `./gradlew assembleRelease`. On GitHub: add the keystore as the secret `SR_KEYSTORE_BASE64` (`base64 -w0 simply-reader.keystore`) plus the three other secrets; the workflow then builds a signed release APK as well.

Debug builds on GitHub use a debug key kept in the Actions cache, so one debug build installs over the previous one. The cache expires after 7 days without builds; after that the next debug APK needs an uninstall first.

## Installing

Copy the APK to the phone and open it (allow installing from that app when asked), or with a computer: `adb install -r SimplyReader-<version>.apk`. `-r` keeps the library when updating.

## Testing

`npm test` covers the adapter: book references and ids, import, covers, failed writes, stats, backup layout, restoring a desktop backup (re-keying ids, covers and stats, dropping page counts), a damaged backup, an interrupted restore, and removing books.

On a device or emulator (BlueStacks works: Settings → Advanced → Android Debug Bridge, then `HD-Adb connect 127.0.0.1:5555`):

- Debug builds let Chrome DevTools attach to the WebView: `adb forward tcp:9339 localabstract:webview_devtools_remote_<pid>` (the socket is in `/proc/net/unix`), then use `http://127.0.0.1:9339/json` or `chrome://inspect`.
- `node test/make-fixtures.mjs <dir>` writes `sample.epub`; push it with `adb push` and import it through the app's file picker. If any of its scripts ran, `document.body.dataset.pwned` would be set.
- Kill tests: `adb shell am force-stop io.github.unkindee.simplyreader` right after a page turn, then reopen; the position must be the one shown before.
- Use only synthetic or public-domain books and a sandbox library.

## How it differs from desktop

- **Books** are referred to as `sr-book:<file name>`; the file is in the app's private storage (`files/books/`). A book's id is `sha1(ref).slice(0, 16)`, the desktop formula applied to the reference. Books are copied in when picked (or sent with “Open with”/“Share”); picker URIs are never kept. Files without a known extension are recognised by their first bytes.
- **Data files** (`library.json`, `settings.json`, `stats.json`, `covers/`) have the desktop shapes. Covers are stored as `app://reader/__covers/<id>.jpg` like on desktop and rewritten to a loadable URL for the window, so backups look the same on both. Writes are temp file → fsync → rename → fsync of the folder, and a failed write rejects so the window keeps the change pending.
- **Backups** are the desktop format and move both ways. On Android they are saved and opened with the system file picker. A restore replaces the library on the device; nothing is merged. It keeps a “Before restore” copy (the newest 3), which the backup dialog can save elsewhere.
- **Not on Android:** folder import, “Show in folder”, drag and drop, automatic weekly backups, and the flip/slide page-turn animation (it needs a window capture). Their controls are hidden through `api.capabilities`.
- **Security:** book chapters are `blob:` documents that inherit the page's CSP, so scripts in books never run. The WebView may load only the stored books, covers and a just-picked image from app storage; content URIs and every other file are refused. Links from books open in the browser (web and mail only); nothing else navigates. Network look-ups go through the plugin to the same fixed hosts as on desktop, following redirects only to allowed hosts. Android's own cloud backup is off: it would restore a library without its books.

## Requirements

Android 8 (API 26) or later with an up-to-date Android System WebView (Chromium 117 or later: the reader uses `Object.groupBy`, `color-mix()` and `:has()`). Tested in BlueStacks 5 (Android 9, WebView 129).
