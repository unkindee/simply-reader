package io.github.unkindee.simplyreader;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Copies a book chosen in Android's file picker (or sent with "Open with") into
 * filesDir/books and returns its reference, "sr-book:<file name>". Picker URIs are never kept:
 * the library only ever points at its own copies, like the desktop app.
 */
final class BookImport {

    static final String[] EXTS = { ".epub", ".mobi", ".azw3", ".azw", ".kf8", ".prc", ".fb2", ".fbz", ".cbz", ".pdf" };
    private static final Pattern FORBIDDEN = Pattern.compile("[<>:\"/\\\\|?*\\x00-\\x1f]");
    private static final Pattern DEVICE = Pattern.compile("^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\\.|$)", Pattern.CASE_INSENSITIVE);
    private static final Object LOCK = new Object(); // one import at a time: names are claimed safely

    static final class Result {
        String ref, name, error;
    }

    private BookImport() {}

    static String ext(String name) {
        int i = name.lastIndexOf('.');
        return i <= 0 ? "" : name.substring(i).toLowerCase(Locale.ROOT);
    }

    static boolean supported(String name) {
        String e = ext(name);
        for (String x : EXTS) if (x.equals(e)) return true;
        return false;
    }

    /** the same rules as portableName() in src/shared/rules.mjs, so backups restore anywhere */
    static String portableName(String name) {
        int i = name.lastIndexOf('.');
        String ext = i <= 0 ? "" : name.substring(i);
        String stem = FORBIDDEN.matcher(name.substring(0, name.length() - ext.length())).replaceAll("_");
        if (stem.isEmpty() || DEVICE.matcher(stem).find()) stem = "_" + stem;
        return stem + ext;
    }

    static Result importUri(Context ctx, Uri uri) {
        Result r = new Result();
        ContentResolver cr = ctx.getContentResolver();
        String name = null;
        long size = -1;
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        } catch (Exception ignored) {
            // some providers don't answer; fall back to the URI
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.trim().isEmpty()) name = "Book";
        name = name.trim();
        name = name.substring(name.lastIndexOf('/') + 1);
        if (name.length() > 150) {
            String e = ext(name);
            name = name.substring(0, 150 - e.length()) + e;
        }
        r.name = name;

        File dir = new File(ctx.getFilesDir(), "books");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            r.error = "Could not create the library folder";
            return r;
        }
        if (size > 0 && dir.getUsableSpace() < size + 20L * 1024 * 1024) {
            r.error = "There isn’t enough free storage on this device";
            return r;
        }
        File part = new File(dir, ".import-" + System.nanoTime() + ".part");
        try {
            byte[] head = new byte[4096];
            int headLen = 0;
            MessageDigest sha = MessageDigest.getInstance("SHA-1");
            try (InputStream in = cr.openInputStream(uri); FileOutputStream out = new FileOutputStream(part)) {
                if (in == null) throw new IOException("The file couldn’t be read");
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (headLen < head.length) {
                        int k = Math.min(n, head.length - headLen);
                        System.arraycopy(buf, 0, head, headLen, k);
                        headLen += k;
                    }
                    sha.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
                out.getFD().sync();
            }
            if (part.length() == 0) throw new IOException("The file is empty");
            if (!supported(name)) {
                String sniffed = sniff(head, headLen);
                if (sniffed == null) throw new IOException("Not a supported e-book (EPUB, MOBI, AZW3, PDF, FB2, CBZ)");
                name = name + sniffed;
            }
            name = portableName(name);
            String hash = hex(sha.digest());
            synchronized (LOCK) {
                r.ref = "sr-book:" + place(dir, part, name, hash);
            }
        } catch (Exception e) {
            r.error = Storage.friendly(e.getMessage());
        } finally {
            if (part.exists()) part.delete();
        }
        return r;
    }

    /**
     * Put the copy in place under its name, "name (2).ext" when a different book has that name,
     * or reuse an identical copy that's already there. Names stay unique ignoring case.
     */
    private static String place(File dir, File part, String name, String hash) throws IOException, NoSuchAlgorithmException {
        String e = ext(name);
        String stem = name.substring(0, name.length() - e.length());
        e = name.substring(name.length() - e.length()); // keep the original case of the extension
        for (int n = 1; n < 10000; n++) {
            String candidate = n == 1 ? name : stem + " (" + n + ")" + e;
            File existing = findIgnoringCase(dir, candidate);
            if (existing == null) {
                File dest = new File(dir, candidate);
                Storage.rename(part, dest);
                Storage.syncDir(dir);
                return candidate;
            }
            if (existing.length() == part.length() && hash.equals(hashFile(existing))) return existing.getName();
        }
        throw new IOException("Too many books with this name");
    }

    private static File findIgnoringCase(File dir, String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        String[] names = dir.list();
        if (names == null) return null;
        for (String n : names) if (n.toLowerCase(Locale.ROOT).equals(lower)) return new File(dir, n);
        return null;
    }

    private static String hashFile(File f) throws IOException, NoSuchAlgorithmException {
        MessageDigest sha = MessageDigest.getInstance("SHA-1");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) sha.update(buf, 0, n);
        }
        return hex(sha.digest());
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }

    private static boolean at(byte[] h, int len, int off, String s) {
        byte[] b = s.getBytes(StandardCharsets.ISO_8859_1);
        if (off + b.length > len) return false;
        for (int i = 0; i < b.length; i++) if (h[off + i] != b[i]) return false;
        return true;
    }

    /** the format from the first bytes, for files whose name has no usable extension */
    static String sniff(byte[] h, int len) {
        if (at(h, len, 0, "%PDF")) return ".pdf";
        if (at(h, len, 60, "BOOKMOBI")) return ".mobi";
        if (at(h, len, 0, "PK\u0003\u0004")) {
            // an EPUB starts with an uncompressed "mimetype" entry
            if (at(h, len, 30, "mimetype") && at(h, len, 38, "application/epub+zip")) return ".epub";
            return ".cbz"; // opened as a comic; anything else fails to open with a message
        }
        String text = new String(h, 0, len, StandardCharsets.ISO_8859_1);
        if (text.contains("<FictionBook")) return ".fb2";
        return null;
    }
}
