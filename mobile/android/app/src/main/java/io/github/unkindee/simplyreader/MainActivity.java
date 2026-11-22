package io.github.unkindee.simplyreader;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.util.HashMap;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
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

        LocalFilesOnly(Bridge bridge) {
            super(bridge);
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

        private static WebResourceResponse forbidden() {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
        }
    }
}
