package com.jarcompare;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.benf.cfr.reader.Main;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.jar.Manifest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Decompiles a single JAR: runs CFR over the whole archive to turn bytecode
 * back into Java source, and collects every non-class resource as-is. The
 * result is emitted as JSON (between JSON_RESULT_START / JSON_RESULT_END) that
 * the browser zips up for download.
 *
 * Output shape:
 * {
 *   "files": {
 *     "com/foo/Bar.java": { "encoding": "utf8",   "content": "..." },
 *     "META-INF/MANIFEST.MF": { "encoding": "utf8", "content": "..." },
 *     "img/logo.png": { "encoding": "base64", "content": "..." }
 *   }
 * }
 */
public class WebJarDecompiler {

    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("Usage: java WebJarDecompiler <jar>");
            return;
        }

        File jar = new File(args[0]);
        try {
            JsonObject result = decompileJar(jar);
            System.out.println("JSON_RESULT_START");
            System.out.println(new Gson().toJson(result));
            System.out.println("JSON_RESULT_END");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static JsonObject decompileJar(File jar) throws Exception {
        JsonObject result = new JsonObject();
        JsonObject files = new JsonObject();
        result.add("files", files);

        Path tempDir = Files.createTempDirectory("jar-decompile-");
        tempDir.toFile().deleteOnExit();

        // 1. Decompile all classes at once. Running CFR on the whole JAR keeps
        //    inner/anonymous classes attached to their outer source file.
        System.out.println("PROGRESS_MSG:Decompiling classes with CFR ...");
        Path sourceDir = Files.createDirectory(tempDir.resolve("src"));

        PrintStream originalOut = System.out;
        System.setOut(new PrintStream(new ByteArrayOutputStream()));
        try {
            Main.main(new String[]{
                jar.getAbsolutePath(),
                "--outputdir", sourceDir.toString(),
                "--silent", "true",
                "--comments", "false"
            });
        } finally {
            System.setOut(originalOut);
        }

        // 2. Collect every generated .java file.
        int[] javaCount = {0};
        if (Files.exists(sourceDir)) {
            Files.walk(sourceDir)
                .filter(p -> p.toString().endsWith(".java"))
                .forEach(p -> {
                    try {
                        String rel = sourceDir.relativize(p).toString().replace('\\', '/');
                        String content = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
                        addFile(files, rel, content, "utf8");
                        javaCount[0]++;
                    } catch (IOException e) {
                        // skip unreadable file
                    }
                });
        }
        System.out.println("PROGRESS_MSG:Decompiled " + javaCount[0] + " source files. Collecting resources ...");

        // 3. Collect non-class resources from the JAR verbatim.
        try (ZipFile zip = new ZipFile(jar)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (name.endsWith(".class")) continue; // already decompiled to .java

                try (InputStream is = zip.getInputStream(entry)) {
                    byte[] data = readAll(is);
                    if (isText(data)) {
                        addFile(files, name, new String(data, StandardCharsets.UTF_8), "utf8");
                    } else {
                        addFile(files, name, Base64.getEncoder().encodeToString(data), "base64");
                    }
                } catch (Exception e) {
                    // skip unreadable entry
                }
            }
        }

        // 4. Compute JAR metadata for the info bar.
        try {
            result.add("meta", buildMeta(jar));
        } catch (Exception e) {
            // metadata is best-effort; never fail the whole decompile over it
        }

        System.out.println("PROGRESS_MSG:Packaging archive ...");
        return result;
    }

    /** Inspect the archive and manifest to extract human-readable metadata. */
    private static JsonObject buildMeta(File jar) throws Exception {
        JsonObject meta = new JsonObject();
        try (ZipFile zip = new ZipFile(jar)) {
            int classCount = 0, resourceCount = 0;
            long totalSize = 0, latest = 0;
            int minMajor = Integer.MAX_VALUE, maxMajor = 0;
            boolean signed = false;
            Set<String> packages = new TreeSet<>();

            Enumeration<? extends ZipEntry> en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                String name = e.getName();
                long t = e.getTime();
                if (t > latest) latest = t;
                long sz = e.getSize();
                if (sz > 0) totalSize += sz;

                if (name.endsWith(".class")) {
                    classCount++;
                    int slash = name.lastIndexOf('/');
                    if (slash > 0) packages.add(name.substring(0, slash));
                    int major = classMajor(zip, e);
                    if (major > 0) {
                        if (major < minMajor) minMajor = major;
                        if (major > maxMajor) maxMajor = major;
                    }
                } else {
                    resourceCount++;
                    if (name.matches("(?i)META-INF/[^/]+\\.(SF|RSA|DSA|EC)")) signed = true;
                }
            }

            // Java compiled version (class major 52 == Java 8, etc.)
            if (maxMajor > 0) {
                String jv = (minMajor == maxMajor)
                    ? "Java " + (maxMajor - 44)
                    : "Java " + (minMajor - 44) + "-" + (maxMajor - 44);
                meta.addProperty("javaVersion", jv);
            }
            if (latest > 0) {
                meta.addProperty("buildDate", new SimpleDateFormat("yyyy-MM-dd").format(new Date(latest)));
            }
            meta.addProperty("classCount", classCount);
            meta.addProperty("packageCount", packages.size());
            meta.addProperty("resourceCount", resourceCount);
            if (totalSize > 0) meta.addProperty("totalSize", totalSize);
            if (signed) meta.addProperty("signed", true);

            // Manifest attributes
            ZipEntry mfe = zip.getEntry("META-INF/MANIFEST.MF");
            if (mfe != null) {
                try (InputStream is = zip.getInputStream(mfe)) {
                    Manifest mf = new Manifest(is);
                    putIf(meta, "mainClass", mf.getMainAttributes().getValue("Main-Class"));
                    putIf(meta, "buildJdk", first(
                        mf.getMainAttributes().getValue("Build-Jdk-Spec"),
                        mf.getMainAttributes().getValue("Build-Jdk"),
                        mf.getMainAttributes().getValue("Created-By")));
                    putIf(meta, "implementationVersion", mf.getMainAttributes().getValue("Implementation-Version"));
                    putIf(meta, "implementationVendor", mf.getMainAttributes().getValue("Implementation-Vendor"));
                    putIf(meta, "specificationVersion", mf.getMainAttributes().getValue("Specification-Version"));
                    String mr = mf.getMainAttributes().getValue("Multi-Release");
                    if (mr != null && mr.trim().equalsIgnoreCase("true")) meta.addProperty("multiRelease", true);
                } catch (Exception ignore) {
                    // malformed manifest — skip
                }
            }

            // Maven coordinates from pom.properties
            Enumeration<? extends ZipEntry> en2 = zip.entries();
            while (en2.hasMoreElements()) {
                ZipEntry e = en2.nextElement();
                String name = e.getName();
                if (!e.isDirectory() && name.startsWith("META-INF/maven/") && name.endsWith("/pom.properties")) {
                    try (InputStream is = zip.getInputStream(e)) {
                        Properties p = new Properties();
                        p.load(is);
                        String g = p.getProperty("groupId");
                        String a = p.getProperty("artifactId");
                        String v = p.getProperty("version");
                        if (g != null && a != null) {
                            meta.addProperty("maven", g + ":" + a + (v != null ? ":" + v : ""));
                        }
                    } catch (Exception ignore) {
                        // skip
                    }
                    break; // first module only
                }
            }
        }
        return meta;
    }

    /** Read the class-file major version (bytes 6-7) without loading the whole class. */
    private static int classMajor(ZipFile zip, ZipEntry e) {
        try (InputStream is = zip.getInputStream(e)) {
            byte[] head = new byte[8];
            int read = 0;
            while (read < 8) {
                int r = is.read(head, read, 8 - read);
                if (r < 0) break;
                read += r;
            }
            if (read < 8) return -1;
            return ((head[6] & 0xff) << 8) | (head[7] & 0xff);
        } catch (IOException ex) {
            return -1;
        }
    }

    private static void putIf(JsonObject o, String key, String val) {
        if (val != null && !val.trim().isEmpty()) o.addProperty(key, val.trim());
    }

    private static String first(String... vals) {
        for (String v : vals) if (v != null && !v.trim().isEmpty()) return v.trim();
        return null;
    }

    /** Read a stream fully (Java 8 compatible — no InputStream.readAllBytes). */
    private static byte[] readAll(InputStream is) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = is.read(chunk)) != -1) buffer.write(chunk, 0, n);
        return buffer.toByteArray();
    }

    private static void addFile(JsonObject files, String path, String content, String encoding) {
        JsonObject obj = new JsonObject();
        obj.addProperty("encoding", encoding);
        obj.addProperty("content", content);
        files.add(path, obj);
    }

    /** Heuristic: treat as binary if it contains a NUL byte in the first chunk. */
    private static boolean isText(byte[] data) {
        int limit = Math.min(data.length, 8000);
        for (int i = 0; i < limit; i++) {
            if (data[i] == 0) return false;
        }
        return true;
    }
}
