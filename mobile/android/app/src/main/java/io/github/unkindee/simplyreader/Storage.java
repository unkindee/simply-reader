package io.github.unkindee.simplyreader;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;

/** Paths inside the app's private storage, and writes that survive a crash or power loss. */
final class Storage {

    private Storage() {}

    /** A path relative to filesDir ("files") or cacheDir ("cache"); never escapes it. */
    static File resolve(Context ctx, String root, String rel) throws IOException {
        File base = "cache".equals(root) ? ctx.getCacheDir() : ctx.getFilesDir();
        if (rel == null || rel.isEmpty() || rel.startsWith("/") || rel.indexOf('\\') >= 0 || rel.indexOf('\0') >= 0)
            throw new IOException("Invalid path");
        for (String part : rel.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IOException("Invalid path");
        }
        File f = new File(base, rel);
        String b = base.getCanonicalPath() + File.separator;
        if (!f.getCanonicalPath().startsWith(b) && !f.getAbsolutePath().startsWith(b)) throw new IOException("Invalid path");
        return f;
    }

    static void rename(File from, File to) throws IOException {
        try {
            Os.rename(from.getAbsolutePath(), to.getAbsolutePath()); // replaces a file at `to` atomically
        } catch (ErrnoException e) {
            throw new IOException(friendly(e.getMessage()), e);
        }
    }

    static void syncDir(File dir) {
        try {
            FileDescriptor fd = Os.open(dir.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            try {
                Os.fsync(fd);
            } finally {
                Os.close(fd);
            }
        } catch (ErrnoException ignored) {
            // not every file system can sync a folder; the file itself is synced already
        }
    }

    /** temp file, fsync, rename, fsync the folder */
    static void writeAtomic(File dest, byte[] data) throws IOException {
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getName());
        File tmp = new File(dir, dest.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.getFD().sync();
        } catch (IOException e) {
            tmp.delete();
            throw new IOException(friendly(e.getMessage()), e);
        }
        rename(tmp, dest);
        if (dir != null) syncDir(dir);
    }

    static boolean removeTree(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) removeTree(k);
        }
        return f.delete() || !f.exists();
    }

    static String friendly(String msg) {
        if (msg != null && (msg.contains("ENOSPC") || msg.contains("No space left")))
            return "There isn’t enough free storage on this device";
        return msg == null ? "Unknown error" : msg;
    }
}
