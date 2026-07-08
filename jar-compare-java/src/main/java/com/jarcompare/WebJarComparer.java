package com.jarcompare;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.benf.cfr.reader.Main;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public class WebJarComparer {

    public static void main(String[] args) {
        if (args.length < 2) {
            System.err.println("Usage: java WebJarComparer <jar1> <jar2>");
            return;
        }

        File jar1 = new File(args[0]);
        File jar2 = new File(args[1]);

        try {
            JsonObject result = compareJars(jar1, jar2);
            System.out.println("JSON_RESULT_START");
            System.out.println(new Gson().toJson(result));
            System.out.println("JSON_RESULT_END");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static JsonObject compareJars(File jar1, File jar2) throws Exception {
        JsonObject result = new JsonObject();
        result.add("added", new JsonArray());
        result.add("removed", new JsonArray());
        result.add("modifiedClasses", new JsonArray());
        result.add("modified", new JsonArray());
        result.add("modifiedNested", new JsonArray());

        JsonObject fileContents = new JsonObject();
        result.add("contents", fileContents);

        Path tempDir = Files.createTempDirectory("jar-compare-");
        tempDir.toFile().deleteOnExit();

        compareJarsRecursive(jar1, jar2, "", result, fileContents, tempDir);

        return result;
    }

    private static void compareJarsRecursive(File jar1, File jar2, String prefix, JsonObject result, JsonObject fileContents, Path tempDir) throws Exception {
        Map<String, String> hashes1 = getHashes(jar1);
        Map<String, String> hashes2 = getHashes(jar2);

        Set<String> onlyIn1 = new TreeSet<>(hashes1.keySet());
        onlyIn1.removeAll(hashes2.keySet());

        Set<String> onlyIn2 = new TreeSet<>(hashes2.keySet());
        onlyIn2.removeAll(hashes1.keySet());

        Set<String> common = new TreeSet<>(hashes1.keySet());
        common.retainAll(hashes2.keySet());

        List<String> modifiedClasses = new ArrayList<>();
        List<String> modifiedOther = new ArrayList<>();

        for (String file : common) {
            if (!hashes1.get(file).equals(hashes2.get(file))) {
                if (file.endsWith(".class")) {
                    modifiedClasses.add(file);
                } else {
                    modifiedOther.add(file);
                }
            }
        }

        JsonArray addedArr = result.getAsJsonArray("added");
        for (String s : onlyIn2) addedArr.add(prefix + s);

        JsonArray removedArr = result.getAsJsonArray("removed");
        for (String s : onlyIn1) removedArr.add(prefix + s);

        JsonArray modClassesArr = result.getAsJsonArray("modifiedClasses");
        for (String s : modifiedClasses) modClassesArr.add(prefix + s);

        JsonArray modOtherArr = result.getAsJsonArray("modified");

        // Removed files content
        for (String s : onlyIn1) {
            JsonObject contentObj = new JsonObject();
            contentObj.addProperty("content1", getFileContent(jar1, s, tempDir));
            fileContents.add(prefix + s, contentObj);
        }

        // Added files content
        for (String s : onlyIn2) {
            JsonObject contentObj = new JsonObject();
            contentObj.addProperty("content2", getFileContent(jar2, s, tempDir));
            fileContents.add(prefix + s, contentObj);
        }

        JsonArray modNestedArr = result.getAsJsonArray("modifiedNested");

        // Modified files content
        for (String s : modifiedOther) {
            if (isNestedArchive(s)) {
                // A changed nested archive (jar/war/ear). Rather than eagerly
                // recursing and decompiling everything inside it up front, report
                // it as a single entry. The web UI drills into it on demand,
                // re-running this comparer on the two nested archives.
                modNestedArr.add(prefix + s);
            } else {
                modOtherArr.add(prefix + s);
                JsonObject contentObj = new JsonObject();
                contentObj.addProperty("content1", getFileContent(jar1, s, tempDir));
                contentObj.addProperty("content2", getFileContent(jar2, s, tempDir));
                fileContents.add(prefix + s, contentObj);
            }
        }

        // Modified classes content
        for (String s : modifiedClasses) {
            JsonObject contentObj = new JsonObject();
            contentObj.addProperty("content1", getFileContent(jar1, s, tempDir));
            contentObj.addProperty("content2", getFileContent(jar2, s, tempDir));
            fileContents.add(prefix + s, contentObj);
        }
    }

    /** True for nested Java archives we can drill into (jar/war/ear). */
    private static boolean isNestedArchive(String name) {
        String n = name.toLowerCase();
        return n.endsWith(".jar") || n.endsWith(".war") || n.endsWith(".ear");
    }

    private static String getFileContent(File jarFile, String filename, Path tempDir) {
        if (filename.endsWith("/")) return "";
        try {
            if (filename.endsWith(".class")) {
                List<String> lines = extractAndDecompile(jarFile, filename, tempDir);
                return String.join("\n", lines);
            } else {
                try (ZipFile zip = new ZipFile(jarFile)) {
                    ZipEntry entry = zip.getEntry(filename);
                    if (entry != null) {
                        try (InputStream is = zip.getInputStream(entry)) {
                            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                            int nRead;
                            byte[] dataBuffer = new byte[8192];
                            while ((nRead = is.read(dataBuffer, 0, dataBuffer.length)) != -1) {
                                buffer.write(dataBuffer, 0, nRead);
                            }
                            byte[] data = buffer.toByteArray();
                            String text = new String(data, "UTF-8");
                            if (text.contains("\u0000")) {
                                return "Binary file (Content not shown)";
                            }
                            return text;
                        }
                    }
                }
            }
        } catch (Exception e) {
            return "Error extracting file: " + e.getMessage();
        }
        return "";
    }

    private static Map<String, String> getHashes(File jarFile) throws Exception {
        Map<String, String> map = new HashMap<>();
        try (ZipFile zip = new ZipFile(jarFile)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (!entry.isDirectory()) {
                    try (InputStream is = zip.getInputStream(entry)) {
                        md.reset();
                        byte[] buffer = new byte[8192];
                        int bytesRead;
                        while ((bytesRead = is.read(buffer)) != -1) {
                            md.update(buffer, 0, bytesRead);
                        }
                        byte[] hash = md.digest();
                        StringBuilder sb = new StringBuilder();
                        for (byte b : hash) sb.append(String.format("%02x", b));
                        map.put(entry.getName(), sb.toString());
                    }
                }
            }
        }
        return map;
    }

    private static List<String> extractAndDecompile(File jarFile, String className, Path tempDir) throws Exception {
        System.out.println("PROGRESS_MSG:Decompiling " + className + " ...");
        Path extractDir = Files.createTempDirectory(tempDir, "extract-");
        Path classFile = extractDir.resolve(Paths.get(className).getFileName().toString());

        try (ZipFile zip = new ZipFile(jarFile)) {
            ZipEntry entry = zip.getEntry(className);
            if (entry != null) {
                try (InputStream is = zip.getInputStream(entry)) {
                    Files.copy(is, classFile, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }

        Path outputDir = Files.createTempDirectory(tempDir, "decompile-");
        
        PrintStream originalOut = System.out;
        System.setOut(new PrintStream(new ByteArrayOutputStream()));
        try {
            Main.main(new String[]{classFile.toString(), "--outputdir", outputDir.toString(), "--silent", "true"});
        } finally {
            System.setOut(originalOut);
        }

        List<String> result = new ArrayList<>();
        Files.walk(outputDir)
                .filter(p -> p.toString().endsWith(".java"))
                .findFirst()
                .ifPresent(p -> {
                    try {
                        result.addAll(Files.readAllLines(p));
                    } catch (IOException e) {
                        e.printStackTrace();
                    }
                });
        return result;
    }
}
