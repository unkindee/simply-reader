package io.github.unkindee.simplyreader;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import androidx.core.splashscreen.SplashScreen;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.util.HashMap;

public class MainActivity extends BridgeActivity {

    // The splash screen stays until the window has set itself up (theme, library) and says so
    // through SimplyReaderPlugin.ready, at most 5 s: before that the page is only half drawn.
    private static volatile boolean webReady;
    private static volatile long readyDeadline;

    static void markReady() {
        if (webReady) return;
        webReady = true;
        Log.i("SimplyReader", "window ready " + (SystemClock.uptimeMillis() - Process.getStartUptimeMillis()) + " ms after the app started");
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        webReady = false;
        readyDeadline = SystemClock.uptimeMillis() + 5000;
        SplashScreen.installSplashScreen(this)
            .setKeepOnScreenCondition(() -> !webReady && SystemClock.uptimeMillis() < readyDeadline);
        registerPlugin(SimplyReaderPlugin.class);
        super.onCreate(savedInstanceState);
        WebView web = getBridge().getWebView();
        WebSettings s = web.getSettings();
        // the app is served from https://localhost; it never needs file:// or content:// URLs
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        getBridge().setWebViewClient(new LocalFilesOnly(getBridge()));
    }

    /**
     * Capacitor serves any file the app can read under /_capacitor_file_/ and any content:// URI
     * under /_capacitor_content_/. The reader needs only its stored books and covers, and an image
     * just picked for a cover, so everything else is refused.
     */
    static class LocalFilesOnly extends BridgeWebViewClient {
        private final String[] allowed;
        private final Bridge owner;
        private static long lastRendererLoss = 0;

        LocalFilesOnly(Bridge bridge) {
            super(bridge);
            owner = bridge;
            File files = bridge.getContext().getFilesDir();
            File cache = bridge.getContext().getCacheDir();
            allowed = new String[] {
                canonical(new File(files, "books")) + File.separator,
                canonical(new File(files, "covers")) + File.separator,
                canonical(new File(cache, "picked")) + File.separator,
            };
        }

        private static String canonical(File f) {
            try {
                return f.getCanonicalPath();
            } catch (IOException e) {
                return f.getAbsolutePath();
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String path = url.getPath();
            if ("localhost".equalsIgnoreCase(url.getHost()) && path != null) {
                if (path.startsWith("/_capacitor_content_")) return forbidden();
                if (path.startsWith("/_capacitor_file_")) {
                    String file = canonical(new File(path.substring("/_capacitor_file_".length())));
                    boolean ok = false;
                    for (String dir : allowed) if (file.startsWith(dir)) ok = true;
                    if (!ok) return forbidden();
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        /**
         * The page engine crashed, or Android ended it to free memory. Left alone, Android would
         * close the whole app; instead the window starts again, and the book that was open reopens
         * (app.js, rememberOpenBook). A second loss within a minute would be a loop: the window closes.
         */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            super.onRenderProcessGone(view, detail);
            Activity activity = owner.getActivity();
            long now = SystemClock.uptimeMillis();
            boolean again = lastRendererLoss != 0 && now - lastRendererLoss < 60000;
            lastRendererLoss = now;
            Log.w("SimplyReader", "page engine " + (detail.didCrash() ? "crashed" : "was ended by Android") + (again ? ", again: closing" : ": restarting the window"));
            if (activity != null && !activity.isFinishing()) {
                if (again) activity.finish(); else activity.recreate();
            }
            return true;
        }

        private static WebResourceResponse forbidden() {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
        }
    }
}
