package com.jarcompare;

import org.benf.cfr.reader.Main;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public class JarComparer {
    public static final String RED = "\033[91m";
    public static final String GREEN = "\033[92m";
    public static final String YELLOW = "\033[93m";
    public static final String RESET = "\033[0m";

    public static void main(String[] args) throws Exception {
        boolean fullNested = false;
        List<String> jars = new ArrayList<>();
        for (String arg : args) {
            if (arg.equals("--nested")) {
                fullNested = true;
            } else {
                jars.add(arg);
            }
        }

        if (jars.size() != 2) {
            System.out.println("Usage: java -jar jar-comparer.jar [--nested] <jar1> <jar2>");
            System.exit(1);
        }

        File jar1 = new File(jars.get(0));
        File jar2 = new File(jars.get(1));

        compareJars(jar1, jar2, fullNested, "", false);
    }

    private static void compareJars(File jar1, File jar2, boolean fullNested, String prefix, boolean isNestedLevel) throws Exception {
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

        if (!isNestedLevel || fullNested) {
            if (!isNestedLevel) {
                System.out.println(prefix + "Comparing:");
                System.out.println(prefix + "  [1] " + jar1.getAbsolutePath());
                System.out.println(prefix + "  [2] " + jar2.getAbsolutePath() + "\n");
            }

            if (!onlyIn1.isEmpty()) {
                System.out.println(prefix + RED + "--- Files only in JAR 1 ---" + RESET);
                for (String f : onlyIn1) System.out.println(prefix + RED + "  - " + f + RESET);
                System.out.println();
            }

            if (!onlyIn2.isEmpty()) {
                System.out.println(prefix + GREEN + "--- Files only in JAR 2 ---" + RESET);
                for (String f : onlyIn2) System.out.println(prefix + GREEN + "  + " + f + RESET);
                System.out.println();
            }
        }

        if (!modifiedClasses.isEmpty() || (!isNestedLevel && !modifiedOther.isEmpty()) || (isNestedLevel && fullNested && !modifiedOther.isEmpty())) {
            if (!isNestedLevel || fullNested) {
                System.out.println(prefix + YELLOW + "--- Files with differing content ---" + RESET);
            } else if (!modifiedClasses.isEmpty()) {
                System.out.println(prefix + YELLOW + "--- Changed Class Files Inside Nested JAR ---" + RESET);
            }
            
            for (String f : modifiedClasses) System.out.println(prefix + YELLOW + "  [CLASS] " + f + RESET);
            
            if (!isNestedLevel || fullNested) {
                for (String f : modifiedOther) System.out.println(prefix + YELLOW + "  [OTHER] " + f + RESET);
            }
            System.out.println();
        }

        if (onlyIn1.isEmpty() && onlyIn2.isEmpty() && modifiedClasses.isEmpty() && modifiedOther.isEmpty()) {
            if (!isNestedLevel) System.out.println(prefix + "The JAR files have identical contents.");
            return;
        }

        Path tempDir = Files.createTempDirectory("jar-compare-");
        tempDir.toFile().deleteOnExit();

        if (!isNestedLevel || fullNested) {
            if (!onlyIn1.isEmpty()) {
                System.out.println(prefix + RED + "Displaying contents of files removed from JAR 2 (Found only in JAR 1):" + RESET);
                showUniqueFiles(jar1, onlyIn1, tempDir, RED, "Deleted", prefix);
            }

            if (!onlyIn2.isEmpty()) {
                System.out.println(prefix + GREEN + "Displaying contents of files added to JAR 2 (Found only in JAR 2):" + RESET);
                showUniqueFiles(jar2, onlyIn2, tempDir, GREEN, "New", prefix);
            }
        }

        if (!modifiedClasses.isEmpty()) {
            if (!isNestedLevel || fullNested) {
                System.out.println(prefix + YELLOW + "Decompiling and comparing Java source code for changed classes...\n" + RESET);
                for (String className : modifiedClasses) {
                    try {
                        List<String> lines1 = extractAndDecompile(jar1, className, tempDir);
                        List<String> lines2 = extractAndDecompile(jar2, className, tempDir);

                        if (lines1.equals(lines2)) {
                            System.out.println("\n" + prefix + YELLOW + "[INFO] " + className + ":" + RESET);
                            System.out.println(prefix + YELLOW + "  -> Decompiled Java source is exactly identical!" + RESET);
                            System.out.println(prefix + YELLOW + "  -> The .class binary differs likely due to changes in comments, line numbers, or compiler version/flags." + RESET);
                        } else {
                            printDiff(className, lines1, lines2);
                        }
                    } catch (Exception e) {
                        System.out.println(prefix + "Error diffing " + className + ": " + e.getMessage());
                    }
                }
            } else {
                System.out.println(prefix + YELLOW + "[INFO] Skipping decompilation for nested JAR class files. Use --nested to view full diffs." + RESET);
            }
        }

        if (!modifiedOther.isEmpty()) {
            for (String filename : modifiedOther) {
                if (filename.endsWith(".jar")) {
                    System.out.println("\n" + prefix + YELLOW + "==========================================================================" + RESET);
                    System.out.println(prefix + YELLOW + ">>> ENTERING NESTED JAR: " + filename + RESET);
                    System.out.println(prefix + YELLOW + "==========================================================================\n" + RESET);
                    
                    Path t1 = Files.createTempFile("nested1-", ".jar");
                    Path t2 = Files.createTempFile("nested2-", ".jar");
                    
                    extractRawFile(jar1, filename, t1);
                    extractRawFile(jar2, filename, t2);
                    
                    compareJars(t1.toFile(), t2.toFile(), fullNested, prefix + "    ", true);
                    
                    Files.deleteIfExists(t1);
                    Files.deleteIfExists(t2);
                    
                    System.out.println("\n" + prefix + YELLOW + "<<< EXITING NESTED JAR: " + filename + RESET + "\n");
                    continue;
                }

                if (!isNestedLevel || fullNested) {
                    try {
                        List<String> lines1 = extractTextFile(jar1, filename);
                        List<String> lines2 = extractTextFile(jar2, filename);

                        if (lines1 != null && lines2 != null) {
                            printDiff(filename, lines1, lines2);
                        } else {
                            System.out.println("\n" + prefix + YELLOW + "[INFO] Skipping binary diff for: " + filename + RESET);
                        }
                    } catch (Exception e) {
                        System.out.println(prefix + "Error diffing " + filename + ": " + e.getMessage());
                    }
                }
            }
        }
    }

    private static void extractRawFile(File jarFile, String filename, Path dest) throws Exception {
        try (ZipFile zip = new ZipFile(jarFile)) {
            ZipEntry entry = zip.getEntry(filename);
            if (entry != null) {
                try (InputStream is = zip.getInputStream(entry)) {
                    Files.copy(is, dest, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
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

    private static void showUniqueFiles(File jarFile, Set<String> files, Path tempDir, String color, String label, String prefix) throws Exception {
        try (ZipFile zip = new ZipFile(jarFile)) {
            for (String filename : files) {
                if (filename.endsWith("/")) continue;
                if (filename.endsWith(".class")) {
                    List<String> lines = extractAndDecompile(jarFile, filename, tempDir);
                    System.out.println("\n" + prefix + color + "--- " + label + " Source: " + filename + " ---" + RESET);
                    for (String line : lines) System.out.println(prefix + color + line + RESET);
                } else {
                    ZipEntry entry = zip.getEntry(filename);
                    if (entry != null) {
                        try (InputStream is = zip.getInputStream(entry)) {
                            String text = new String(is.readAllBytes(), "UTF-8");
                            if (text.contains("\u0000")) {
                                System.out.println("\n" + prefix + color + "--- " + label + " Binary File (Content not shown): " + filename + " ---" + RESET);
                            } else {
                                System.out.println("\n" + prefix + color + "--- " + label + " File Content: " + filename + " ---" + RESET);
                                System.out.println(prefix + color + text + RESET);
                            }
                        }
                    }
                }
            }
        }
        System.out.println();
    }

    private static List<String> extractAndDecompile(File jarFile, String className, Path tempDir) throws Exception {
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

    private static List<String> extractTextFile(File jarFile, String filename) throws Exception {
        try (ZipFile zip = new ZipFile(jarFile)) {
            ZipEntry entry = zip.getEntry(filename);
            if (entry != null) {
                try (InputStream is = zip.getInputStream(entry)) {
                    byte[] data = is.readAllBytes();
                    String text = new String(data, "UTF-8");
                    if (text.contains("\u0000")) {
                        return null; // Indicates binary file
                    }
                    if (text.isEmpty()) {
                        return new ArrayList<>();
                    }
                    return Arrays.asList(text.split("\r?\n", -1));
                }
            }
        }
        return new ArrayList<>();
    }

    private static void printDiff(String filename, List<String> lines1, List<String> lines2) throws Exception {
        Path f1 = Files.createTempFile("java-diff1-", ".java");
        Path f2 = Files.createTempFile("java-diff2-", ".java");
        Files.write(f1, lines1);
        Files.write(f2, lines2);

        try {
            int width = 160;
            try {
                Process p = new ProcessBuilder("sh", "-c", "stty size < /dev/tty 2>/dev/null").start();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                    String line = r.readLine();
                    if (line != null && line.trim().contains(" ")) {
                        width = Integer.parseInt(line.trim().split(" ")[1]);
                    } else {
                        Process p2 = new ProcessBuilder("tput", "cols").start();
                        try (BufferedReader r2 = new BufferedReader(new InputStreamReader(p2.getInputStream()))) {
                            String line2 = r2.readLine();
                            if (line2 != null && !line2.trim().isEmpty()) {
                                width = Integer.parseInt(line2.trim());
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}

            System.out.println("\n" + "=".repeat(width));
            System.out.println("Side-by-side diff for: " + filename);
            System.out.println("=".repeat(width));

            ProcessBuilder pb = new ProcessBuilder("diff", "-y", "-W", String.valueOf(width), "--color=always", f1.toString(), f2.toString());
            pb.inheritIO();
            Process process = pb.start();
            process.waitFor();
        } finally {
            Files.deleteIfExists(f1);
            Files.deleteIfExists(f2);
        }
    }
}
