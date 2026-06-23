# JAR Comparer

JAR Comparer is a specialized Java command-line utility designed to perform deep comparisons between two compiled JAR files. Rather than just reporting which files have changed, it decompiles modified `.class` files on-the-fly and presents a beautiful, full-width, side-by-side source code diff directly in your terminal.

## Architecture

The project is structured as a standalone, single-executable Java application (`jar-comparer`). 

### Core Workflow
1. **Cryptographic Hashing:** When provided with two JAR files, the tool iterates through every file inside both archives and computes an **SHA-256 hash** of their binary contents.
2. **Set Operations:** By comparing the hashes, it categorizes files into four groups:
   - Files only in JAR 1 (Removed)
   - Files only in JAR 2 (Added)
   - Identical Files (Ignored)
   - Modified Files (Separated into `.class` files, `.jar` files, and textual files like `.yaml` / `.properties`)
3. **Decompilation:** The tool embeds the **CFR Decompiler** (`org.benf:cfr:0.152`) directly into the final executable using the Maven Shade plugin. Modified `.class` files are extracted to a temporary directory, and the CFR API is invoked silently to reconstruct the original Java source code.
4. **Metadata Quirks:** Occasionally, two `.class` files have different binary hashes due to varying compiler flags or line numbers, but their actual Java logic is identical. The tool is smart enough to detect when the decompiled source code matches exactly, and will inform you rather than showing a useless empty diff.
5. **Terminal Diffing:** The tool determines your exact terminal window width dynamically by querying the operating system (`stty size < /dev/tty`). It then writes the decompiled source codes (or text files) to temporary files and spawns a system `diff -y -W <width> --color=always` process to render a side-by-side comparison that perfectly utilizes your screen real estate.
6. **Nested JAR Inspection:** The tool is fully aware of "Fat JARs" (like Spring Boot applications containing `BOOT-INF/lib/*.jar`). It automatically dives into modified nested JARs and computes which classes changed inside them.

---

## Usage

### Prerequisites
- Java 11 or higher
- Maven (for building)
- A Unix-like environment with the `diff` utility installed (Linux/macOS)

### Building the Project
To compile the code and build the single "uber-jar" containing all dependencies:

```bash
cd jar-compare-java
mvn clean package
```
This will produce an executable JAR at `target/jar-comparer-1.0-SNAPSHOT.jar`.

### Running the Comparison
Simply pass the paths to the two JAR files you wish to compare.

```bash
java -jar target/jar-comparer-1.0-SNAPSHOT.jar /path/to/old-release.jar /path/to/new-release.jar
```

#### Default Behavior
In its default mode, the tool keeps the output as clean as possible:
- Top-level added and removed files are listed.
- Top-level textual files (`.yaml`, `.properties`) are diffed.
- Top-level `.class` files are decompiled and diffed.
- **Nested JARs:** It will scan inside nested JARs and list the `.class` files that were modified, but it will **skip** decompiling them to prevent massive walls of noise from third-party library updates.

#### Deep Dive Mode (`--nested`)
If you want to perform a deep inspection and actually see the line-by-line source code diffs for classes *inside* nested JARs, pass the `--nested` flag as the first argument:

```bash
java -jar target/jar-comparer-1.0-SNAPSHOT.jar --nested /path/to/old.jar /path/to/new.jar
```
This will recursively apply the full decompilation and diffing logic to every modified layer of the archive.
