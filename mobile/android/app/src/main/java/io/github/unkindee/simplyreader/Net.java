package io.github.unkindee.simplyreader;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Pattern;

/**
 * The only network access the app has, the same as on desktop: dictionary and Wikipedia
 * look-ups, book details and cover images, each from a fixed list of hosts over HTTPS. The
 * window itself can't reach the network (its content policy has no remote hosts), so it asks
 * here. Redirects are followed by hand and every hop must stay on the list.
 */
final class Net {

    static final String UA = "SimplyReader/1.0 (e-book reader; Android)";

    // look-ups and book details (JSON)
    private static final Pattern JSON_HOSTS = Pattern.compile("^(en\\.wiktionary\\.org|[a-z]{2,3}\\.wikipedia\\.org|itunes\\.apple\\.com|openlibrary\\.org)$");
    // cover images; Open Library's covers are served from the Internet Archive
    private static final Pattern IMAGE_HOSTS = Pattern.compile("^(is\\d+-ssl\\.mzstatic\\.com|covers\\.openlibrary\\.org)$");
    private static final Pattern IMAGE_REDIRECT_HOSTS = Pattern.compile("^(is\\d+-ssl\\.mzstatic\\.com|covers\\.openlibrary\\.org|archive\\.org|ia\\d+\\.us\\.archive\\.org)$");

    static final class Response {
        int status;
        String type;
        byte[] body;
    }

    private Net() {}

    static boolean allowed(String url, boolean image) {
        try {
            URL u = new URL(url);
            return "https".equals(u.getProtocol()) && u.getPort() == -1 && (image ? IMAGE_HOSTS : JSON_HOSTS).matcher(u.getHost()).matches();
        } catch (Exception e) {
            return false;
        }
    }

    static Response get(String url, boolean image) throws IOException {
        if (!allowed(url, image)) throw new IOException("Host not allowed");
        Pattern hops = image ? IMAGE_REDIRECT_HOSTS : JSON_HOSTS;
        long max = image ? 20L * 1024 * 1024 : 5L * 1024 * 1024;
        URL u = new URL(url);
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) u.openConnection();
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Api-User-Agent", UA);
                c.setRequestProperty("Accept", image ? "image/*" : "application/json");
                int status = c.getResponseCode();
                if (status >= 300 && status < 400) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null) throw new IOException("Redirect without a location");
                    URL next = new URL(u, loc);
                    if (!"https".equals(next.getProtocol()) || next.getPort() != -1 || !hops.matcher(next.getHost()).matches())
                        throw new IOException("Redirect to a host that isn’t allowed");
                    u = next;
                    continue;
                }
                Response r = new Response();
                r.status = status;
                r.type = c.getContentType();
                if (status >= 200 && status < 300) {
                    long len = c.getContentLengthLong();
                    if (len > max) throw new IOException("Response too large");
                    try (InputStream in = c.getInputStream()) {
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        long total = 0;
                        while ((n = in.read(buf)) > 0) {
                            total += n;
                            if (total > max) throw new IOException("Response too large");
                            out.write(buf, 0, n);
                        }
                        r.body = out.toByteArray();
                    }
                }
                return r;
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("Too many redirects");
    }
}
