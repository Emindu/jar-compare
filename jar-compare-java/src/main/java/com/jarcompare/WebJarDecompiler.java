package com.jarcompare;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.benf.cfr.reader.Main;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
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

        System.out.println("PROGRESS_MSG:Packaging archive ...");
        return result;
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
