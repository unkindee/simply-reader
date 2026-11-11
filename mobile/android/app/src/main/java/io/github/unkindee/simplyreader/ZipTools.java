package io.github.unkindee.simplyreader;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * Backup archives in the same format as src/zip.js on desktop: UTF-8 names, books and covers
 * stored as they are, JSON deflated, ZIP64 when needed (java.util.zip adds it), and every
 * extracted file checked against its CRC. Everything is streamed; no archive or book is held
 * in memory.
 */
final class ZipTools {

    static final int MAX_ENTRIES = 200_000;

    static final class Entry {
        String name;
        File file; // or
        byte[] data;
    }

    private ZipTools() {}

    static long create(File dest, List<Entry> entries) throws IOException {
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getName());
        File part = new File(dir, dest.getName() + ".part");
        byte[] buf = new byte[256 * 1024];
        try (FileOutputStream fos = new FileOutputStream(part); ZipOutputStream zip = new ZipOutputStream(new BufferedOutputStream(fos, 256 * 1024), StandardCharsets.UTF_8)) {
            for (Entry e : entries) {
                ZipEntry z = new ZipEntry(e.name);
                if (e.data != null) {
                    z.setMethod(ZipEntry.DEFLATED);
                    zip.putNextEntry(z);
                    zip.write(e.data);
                } else {
                    // stored: the size and CRC go in the header first, so read the file twice
                    CRC32 crc = new CRC32();
                    long size = 0;
                    try (InputStream in = new FileInputStream(e.file)) {
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            crc.update(buf, 0, n);
                            size += n;
                        }
                    }
                    z.setMethod(ZipEntry.STORED);
                    z.setSize(size);
                    z.setCompressedSize(size);
                    z.setCrc(crc.getValue());
                    zip.putNextEntry(z);
                    try (InputStream in = new FileInputStream(e.file)) {
                        int n;
                        while ((n = in.read(buf)) > 0) zip.write(buf, 0, n);
                    }
                }
                zip.closeEntry();
            }
            zip.finish();
            zip.flush();
            fos.getFD().sync();
        } catch (IOException e) {
            part.delete();
            throw new IOException(Storage.friendly(e.getMessage()), e);
        }
        Storage.rename(part, dest);
        if (dir != null) Storage.syncDir(dir);
        return dest.length();
    }

    static ZipFile open(File file) throws IOException {
        try {
            ZipFile z = new ZipFile(file, ZipFile.OPEN_READ, StandardCharsets.UTF_8);
            if (z.size() > MAX_ENTRIES) {
                z.close();
                throw new IOException("This backup has too many files");
            }
            return z;
        } catch (IOException e) {
            if ("This backup has too many files".equals(e.getMessage())) throw e;
            throw new IOException("This file isn’t a readable .zip backup (" + e.getMessage() + ")", e);
        }
    }

    static ZipEntry entry(ZipFile z, String name) throws IOException {
        ZipEntry e = z.getEntry(name);
        if (e == null || e.isDirectory()) throw new IOException("Missing from the backup: " + name);
        return e;
    }

    /** copy one entry to `out`, checking its size and CRC */
    private static long copyChecked(ZipFile z, ZipEntry e, OutputStream out, long max) throws IOException {
        CRC32 crc = new CRC32();
        long total = 0;
        byte[] buf = new byte[256 * 1024];
        try (InputStream in = z.getInputStream(e)) {
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > max) throw new IOException("A file in the backup is too large: " + e.getName());
                crc.update(buf, 0, n);
                out.write(buf, 0, n);
            }
        }
        if ((e.getSize() >= 0 && total != e.getSize()) || (e.getCrc() >= 0 && crc.getValue() != e.getCrc()))
            throw new IOException("The backup is damaged (" + e.getName() + " doesn’t match its checksum)");
        return total;
    }

    static String readText(ZipFile z, String name, long max) throws IOException {
        ZipEntry e = z.getEntry(name);
        if (e == null) return null;
        if (e.getSize() > max) throw new IOException("A file in the backup is too large: " + name);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        copyChecked(z, e, out, max);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static long extract(ZipFile z, String name, File dest, long max) throws IOException {
        ZipEntry e = entry(z, name);
        File dir = dest.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir.getName());
        File part = new File(dir, dest.getName() + ".part");
        long n;
        try (FileOutputStream fos = new FileOutputStream(part)) {
            BufferedOutputStream out = new BufferedOutputStream(fos, 256 * 1024);
            n = copyChecked(z, e, out, max);
            out.flush();
            fos.getFD().sync();
        } catch (IOException ex) {
            part.delete();
            throw new IOException(Storage.friendly(ex.getMessage()), ex);
        }
        Storage.rename(part, dest);
        return n;
    }

    static Enumeration<? extends ZipEntry> entries(ZipFile z) {
        return z.entries();
    }
}
