package io.github.unkindee.simplyreader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import android.content.pm.PackageInfo;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.json.JSONObject;

/**
 * Everything the Android version needs from the system, called by mobile/web/api.js (the
 * window.api adapter). Business rules stay in JavaScript; this does file picking, private
 * storage, durable writes, ZIP files, documents the user saves, the system bars and the fixed
 * list of network look-ups.
 */
@CapacitorPlugin(name = "SimplyReader")
public class SimplyReaderPlugin extends Plugin {

    private static final String[] BOOK_TYPES = {
        "application/epub+zip", "application/x-mobipocket-ebook", "application/vnd.amazon.mobi8-ebook", "application/vnd.amazon.ebook",
        "application/x-fictionbook+xml", "application/x-fictionbook", "application/vnd.comicbook+zip", "application/x-cbz",
        "application/pdf", "application/zip", "application/octet-stream", "text/xml", "application/xml"
    };

    private final ExecutorService work = Executors.newCachedThreadPool();
    private final List<String> openedRefs = new ArrayList<>(); // from "Open with", until the window asks
    private final List<JSObject> openedErrors = new ArrayList<>();

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        if (intent != null) handleIncoming(intent);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIncoming(intent);
    }

    // ---------------------------------------------------------------- links
    /** Book links and window.open() land here: web and mail links open outside, nothing else loads. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase();
        if (scheme.equals("blob") || scheme.equals("data") || scheme.equals("about")) return null;
        if (scheme.equals("https") && "localhost".equalsIgnoreCase(url.getHost())) return null;
        if (scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto")) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, url);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } catch (ActivityNotFoundException ignored) {}
        }
        return true;
    }

    // ---------------------------------------------------------------- info
    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("filesDir", getContext().getFilesDir().getAbsolutePath());
        r.put("cacheDir", getContext().getCacheDir().getAbsolutePath());
        r.put("sdk", Build.VERSION.SDK_INT);
        PackageInfo web = WebView.getCurrentWebViewPackage();
        r.put("webView", web == null ? null : web.packageName + " " + web.versionName);
        try {
            PackageInfo self = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", self.versionName);
        } catch (Exception ignored) {}
        call.resolve(r);
    }

    // ---------------------------------------------------------------- files
    private File file(PluginCall call, String key) throws IOException {
        return Storage.resolve(getContext(), call.getString(key + "Root", call.getString("root", "files")), call.getString(key));
    }

    @PluginMethod
    public void readText(PluginCall call) {
        work.execute(() -> {
            try {
                File f = file(call, "path");
                JSObject r = new JSObject();
                if (!f.isFile()) {
                    r.put("text", null);
                } else {
                    long max = call.getDouble("maxBytes", 512.0 * 1024 * 1024).longValue();
                    if (f.length() > max) throw new IOException("File too large: " + f.getName());
                    byte[] data = new byte[(int) f.length()];
                    try (InputStream in = new FileInputStream(f)) {
                        int off = 0, n;
                        while (off < data.length && (n = in.read(data, off, data.length - off)) > 0) off += n;
                    }
                    r.put("text", new String(data, StandardCharsets.UTF_8));
                }
                call.resolve(r);
            } catch (Exception e) {
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        work.execute(() -> {
            try {
                String text = call.getString("text");
                if (text == null) throw new IOException("Nothing to write");
                Storage.writeAtomic(file(call, "path"), text.getBytes(StandardCharsets.UTF_8));
                call.resolve();
            } catch (Exception e) {
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    @PluginMethod
    public void writeBase64(PluginCall call) {
        work.execute(() -> {
            try {
                Storage.writeAtomic(file(call, "path"), Base64.decode(call.getString("data", ""), Base64.DEFAULT));
                call.resolve();
            } catch (Exception e) {
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            File f = file(call, "path");
            JSObject r = new JSObject();
            r.put("exists", f.exists());
            r.put("dir", f.isDirectory());
            r.put("size", f.isFile() ? f.length() : 0);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            File f = file(call, "path");
            JSArray names = new JSArray();
            JSArray sizes = new JSArray();
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) {
                names.put(k.getName());
                sizes.put(k.isFile() ? k.length() : -1);
            }
            JSObject r = new JSObject();
            r.put("names", names);
            r.put("sizes", sizes);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        try {
            File f = file(call, "path");
            if (!f.isDirectory() && !f.mkdirs()) throw new IOException("Could not create " + f.getName());
            call.resolve();
        } catch (Exception e) {
            call.reject(Storage.friendly(e.getMessage()), e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        work.execute(() -> {
            try {
                File f = file(call, "path");
                boolean ok = Boolean.TRUE.equals(call.getBoolean("recursive", false)) ? Storage.removeTree(f) : (f.delete() || !f.exists());
                if (!ok) throw new IOException("Could not delete " + f.getName());
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** rename within private storage; with `ifExists`, a missing source is not an error */
    @PluginMethod
    public void rename(PluginCall call) {
        try {
            File from = file(call, "from"), to = file(call, "to");
            if (!from.exists()) {
                if (Boolean.TRUE.equals(call.getBoolean("ifExists", false))) {
                    call.resolve();
                    return;
                }
                throw new IOException("Not found: " + from.getName());
            }
            File dir = to.getParentFile();
            if (dir != null && !dir.isDirectory()) dir.mkdirs();
            Storage.rename(from, to);
            if (dir != null) Storage.syncDir(dir);
            call.resolve();
        } catch (Exception e) {
            call.reject(Storage.friendly(e.getMessage()), e);
        }
    }

    @PluginMethod
    public void freeSpace(PluginCall call) {
        try {
            JSObject r = new JSObject();
            File f = "cache".equals(call.getString("root")) ? getContext().getCacheDir() : getContext().getFilesDir();
            r.put("bytes", f.getUsableSpace());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    // ---------------------------------------------------------------- importing books
    @PluginMethod
    public void pickBooks(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, BOOK_TYPES);
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, i, "pickBooksResult");
    }

    @ActivityCallback
    private void pickBooksResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        List<Uri> uris = new ArrayList<>();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int k = 0; k < clip.getItemCount(); k++) uris.add(clip.getItemAt(k).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        work.execute(() -> call.resolve(importAll(uris)));
    }

    private JSObject importAll(List<Uri> uris) {
        JSArray refs = new JSArray();
        JSArray errors = new JSArray();
        for (Uri u : uris) {
            BookImport.Result r = BookImport.importUri(getContext(), u);
            if (r.ref != null) refs.put(r.ref);
            else {
                JSObject e = new JSObject();
                e.put("name", r.name);
                e.put("error", r.error);
                errors.put(e);
            }
        }
        JSObject out = new JSObject();
        out.put("refs", refs);
        out.put("errors", errors);
        return out;
    }

    /** "Open with" and "Share" from other apps: the book is imported right away */
    private void handleIncoming(Intent intent) {
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) uris.add(intent.getData());
        else if (Intent.ACTION_SEND.equals(action)) {
            Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (p instanceof Uri) uris.add((Uri) p);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Parcelable> ps = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (ps != null) for (Parcelable p : ps) if (p instanceof Uri) uris.add((Uri) p);
        }
        uris.removeIf(u -> !"content".equals(u.getScheme()) && !"file".equals(u.getScheme()));
        if (uris.isEmpty()) return;
        intent.setAction(Intent.ACTION_MAIN); // not again after a configuration change
        work.execute(() -> {
            JSObject r = importAll(uris);
            synchronized (openedRefs) {
                if (hasListeners("openFiles")) {
                    notifyListeners("openFiles", r);
                    return;
                }
                try {
                    for (int k = 0; k < r.getJSONArray("refs").length(); k++) openedRefs.add(r.getJSONArray("refs").getString(k));
                    for (int k = 0; k < r.getJSONArray("errors").length(); k++) openedErrors.add(JSObject.fromJSONObject(r.getJSONArray("errors").getJSONObject(k)));
                } catch (Exception ignored) {}
            }
        });
    }

    @PluginMethod
    public void takeOpenedFiles(PluginCall call) {
        synchronized (openedRefs) {
            JSObject r = new JSObject();
            JSArray refs = new JSArray(), errors = new JSArray();
            for (String s : openedRefs) refs.put(s);
            for (JSObject e : openedErrors) errors.put(e);
            r.put("refs", refs);
            r.put("errors", errors);
            openedRefs.clear();
            openedErrors.clear();
            call.resolve(r);
        }
    }

    // ---------------------------------------------------------------- documents the user picks or saves
    /** copy one document the user picks (a backup, a cover image) into private storage */
    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        JSArray types = call.getArray("types");
        i.setType("*/*");
        try {
            if (types != null && types.length() > 0) {
                String[] t = new String[types.length()];
                for (int k = 0; k < t.length; k++) t[k] = types.getString(k);
                i.putExtra(Intent.EXTRA_MIME_TYPES, t);
            }
        } catch (Exception ignored) {}
        startActivityForResult(call, i, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        Uri uri = data.getData();
        work.execute(() -> {
            try {
                File dest = file(call, "dest");
                long max = call.getDouble("maxBytes", Double.MAX_VALUE).longValue();
                String name = displayName(uri);
                long size = -1;
                try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
                    if (c != null && c.moveToFirst() && !c.isNull(0)) size = c.getLong(0);
                } catch (Exception ignored) {}
                if (size > max) throw new IOException("The file is too large");
                File dir = dest.getParentFile();
                if (dir != null && !dir.isDirectory()) dir.mkdirs();
                if (size > 0 && dir != null && dir.getUsableSpace() < size + 20L * 1024 * 1024)
                    throw new IOException("There isn’t enough free storage on this device");
                File part = new File(dir, dest.getName() + ".part");
                long total = 0;
                try (InputStream in = getContext().getContentResolver().openInputStream(uri); java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
                    if (in == null) throw new IOException("The file couldn’t be read");
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > max) throw new IOException("The file is too large");
                        out.write(buf, 0, n);
                    }
                    out.getFD().sync();
                } catch (IOException e) {
                    part.delete();
                    throw e;
                }
                Storage.rename(part, dest);
                JSObject r = new JSObject();
                r.put("cancelled", false);
                r.put("name", name);
                r.put("size", total);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {}
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    /** save a file from private storage (or text) where the user chooses: a backup, exported notes */
    @PluginMethod
    public void saveDocument(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(call.getString("mime", "application/octet-stream"));
        i.putExtra(Intent.EXTRA_TITLE, call.getString("name", "file"));
        startActivityForResult(call, i, "saveDocumentResult");
    }

    @ActivityCallback
    private void saveDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        Uri uri = data.getData();
        work.execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("The file couldn’t be written");
                String text = call.getString("text");
                if (text != null) out.write(text.getBytes(StandardCharsets.UTF_8));
                else {
                    try (InputStream in = new FileInputStream(file(call, "path"))) {
                        byte[] buf = new byte[256 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                }
                out.flush();
                JSObject r = new JSObject();
                r.put("saved", true);
                r.put("name", displayName(uri));
                call.resolve(r);
            } catch (Exception e) {
                // don't leave a half-written document behind
                try {
                    android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
                } catch (Exception ignored) {}
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    // ---------------------------------------------------------------- ZIP (backups)
    @PluginMethod
    public void zipCreate(PluginCall call) {
        work.execute(() -> {
            try {
                File dest = file(call, "dest");
                JSArray arr = call.getArray("entries");
                List<ZipTools.Entry> entries = new ArrayList<>();
                for (int k = 0; k < arr.length(); k++) {
                    JSONObject o = arr.getJSONObject(k);
                    ZipTools.Entry e = new ZipTools.Entry();
                    e.name = o.getString("name");
                    if (o.has("text")) e.data = o.getString("text").getBytes(StandardCharsets.UTF_8);
                    else e.file = Storage.resolve(getContext(), o.optString("root", "files"), o.getString("path"));
                    entries.add(e);
                }
                JSObject r = new JSObject();
                r.put("size", ZipTools.create(dest, entries));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    @PluginMethod
    public void zipList(PluginCall call) {
        work.execute(() -> {
            try (ZipFile z = ZipTools.open(file(call, "path"))) {
                JSArray names = new JSArray();
                JSArray sizes = new JSArray();
                Enumeration<? extends ZipEntry> en = ZipTools.entries(z);
                while (en.hasMoreElements()) {
                    ZipEntry e = en.nextElement();
                    if (e.isDirectory()) continue;
                    names.put(e.getName());
                    sizes.put(e.getSize());
                }
                JSObject r = new JSObject();
                r.put("names", names);
                r.put("sizes", sizes);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void zipReadText(PluginCall call) {
        work.execute(() -> {
            try (ZipFile z = ZipTools.open(file(call, "path"))) {
                long max = call.getDouble("maxBytes", 256.0 * 1024 * 1024).longValue();
                JSObject r = new JSObject();
                r.put("text", ZipTools.readText(z, call.getString("name"), max));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** extract several entries: [{ name, dest }] (dest relative to destRoot), CRC-checked */
    @PluginMethod
    public void zipExtract(PluginCall call) {
        work.execute(() -> {
            try (ZipFile z = ZipTools.open(file(call, "path"))) {
                JSArray arr = call.getArray("items");
                String destRoot = call.getString("destRoot", "files");
                long max = call.getDouble("maxBytes", 8.0 * 1024 * 1024 * 1024).longValue();
                long total = 0;
                for (int k = 0; k < arr.length(); k++) {
                    JSONObject o = arr.getJSONObject(k);
                    total += ZipTools.extract(z, o.getString("name"), Storage.resolve(getContext(), destRoot, o.getString("dest")), max);
                }
                JSObject r = new JSObject();
                r.put("bytes", total);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(Storage.friendly(e.getMessage()), e);
            }
        });
    }

    // ---------------------------------------------------------------- window
    /** colour behind the status and navigation bars, and light or dark bar icons */
    @PluginMethod
    public void setChrome(PluginCall call) {
        String bg = call.getString("bg", "#1d1d21");
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", true));
        getActivity().runOnUiThread(() -> {
            try {
                Window w = getActivity().getWindow();
                int color = Color.parseColor(bg);
                w.getDecorView().setBackgroundColor(color);
                // before Android 15 the bars have their own colour (later they're transparent)
                if (Build.VERSION.SDK_INT < 35) {
                    w.setStatusBarColor(color);
                    w.setNavigationBarColor(color);
                }
                WebView web = getBridge().getWebView();
                if (web != null) web.setBackgroundColor(color);
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
                c.setAppearanceLightStatusBars(!dark);
                c.setAppearanceLightNavigationBars(!dark);
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            Window w = getActivity().getWindow();
            View decor = w.getDecorView();
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, decor);
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else c.show(WindowInsetsCompat.Type.systemBars());
            call.resolve(new JSObject().put("on", on));
        });
    }

    // ---------------------------------------------------------------- network (fixed hosts)
    @PluginMethod
    public void httpGet(PluginCall call) {
        work.execute(() -> {
            try {
                boolean image = "image".equals(call.getString("kind"));
                Net.Response res = Net.get(call.getString("url", ""), image);
                JSObject r = new JSObject();
                r.put("status", res.status);
                r.put("type", res.type);
                if (res.body != null) {
                    if (image) r.put("base64", Base64.encodeToString(res.body, Base64.NO_WRAP));
                    else r.put("text", new String(res.body, StandardCharsets.UTF_8));
                }
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        work.shutdown();
    }
}
