import zipfile
import sys
import hashlib
import os
import urllib.request
import subprocess
import tempfile
import difflib

CFR_URL = "https://github.com/leibnitz27/cfr/releases/download/0.152/cfr-0.152.jar"
CFR_JAR = "cfr.jar"

# ANSI Color Codes
RED = '\033[91m'
GREEN = '\033[92m'
YELLOW = '\033[93m'
RESET = '\033[0m'

def ensure_decompiler():
    """Download CFR decompiler if not already present."""
    if not os.path.exists(CFR_JAR):
        print("Downloading CFR decompiler...")
        try:
            urllib.request.urlretrieve(CFR_URL, CFR_JAR)
            print("Downloaded CFR decompiler successfully.")
        except Exception as e:
            print(f"Failed to download CFR: {e}")
            sys.exit(1)

def hash_file_in_zip(z, filename):
    """Calculate SHA-256 hash of a file inside a zip/jar."""
    with z.open(filename) as f:
        return hashlib.sha256(f.read()).hexdigest()

def extract_and_decompile(z, filename, temp_dir):
    """Extracts a .class file and decompiles it, returning the source lines."""
    z.extract(filename, temp_dir)
    class_file_path = os.path.join(temp_dir, filename)
    
    unique_out = tempfile.mkdtemp(dir=temp_dir)
    
    subprocess.run(
        ["java", "-jar", CFR_JAR, class_file_path, "--outputdir", unique_out, "--silent", "true"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    
    java_files = []
    for root, dirs, files in os.walk(unique_out):
        for file in files:
            if file.endswith(".java"):
                java_files.append(os.path.join(root, file))
    
    if java_files:
        with open(java_files[0], 'r', encoding='utf-8', errors='replace') as f:
            return f.readlines()
    return []

def print_diff(filename, lines1, lines2):
    """Print side-by-side diff using the 'diff -y' command."""
    if lines1 == lines2:
        print(f"\n{YELLOW}[INFO] {filename}:{RESET}")
        print(f"{YELLOW}  -> Decompiled Java source is exactly identical!{RESET}")
        print(f"{YELLOW}  -> The .class binary differs likely due to changes in comments, line numbers, or compiler version/flags.{RESET}")
        return

    import shutil
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.java', delete=False, encoding='utf-8') as f1, \
         tempfile.NamedTemporaryFile(mode='w', suffix='.java', delete=False, encoding='utf-8') as f2:
        f1.writelines(lines1)
        f2.writelines(lines2)
        f1_path = f1.name
        f2_path = f2.name
        
    try:
        width = shutil.get_terminal_size((160, 20)).columns
        print(f"\n{'='*width}")
        print(f"Side-by-side diff for: {filename}")
        print(f"{'='*width}")
        
        subprocess.run(["diff", "-y", "-W", str(width), "--color=always", f1_path, f2_path])
    finally:
        if os.path.exists(f1_path): os.remove(f1_path)
        if os.path.exists(f2_path): os.remove(f2_path)

def show_unique_files_content(z, files, temp_dir, color, label):
    """Shows the content of files that are unique to one JAR."""
    for filename in sorted(files):
        if filename.endswith('/'): continue
        if filename.endswith('.class'):
            ensure_decompiler()
            lines = extract_and_decompile(z, filename, temp_dir)
            print(f"\n{color}--- {label} Source: {filename} ---{RESET}")
            for line in lines:
                print(f"{color}{line.rstrip()}{RESET}")
        else:
            with z.open(filename) as f:
                data = f.read()
            try:
                # Attempt to read as UTF-8 text (for xml, properties, yaml, etc.)
                text = data.decode('utf-8')
                print(f"\n{color}--- {label} File Content: {filename} ---{RESET}")
                for line in text.splitlines():
                    print(f"{color}{line}{RESET}")
            except UnicodeDecodeError:
                # Fallback for binary files (e.g., nested jars, images)
                print(f"\n{color}--- {label} Binary File (Content not shown): {filename} ---{RESET}")
    print()

def compare_jars(jar1_path, jar2_path):
    try:
        with zipfile.ZipFile(jar1_path, 'r') as z1, zipfile.ZipFile(jar2_path, 'r') as z2:
            jar1_files = set(z1.namelist())
            jar2_files = set(z2.namelist())

            only_in_jar1 = jar1_files - jar2_files
            only_in_jar2 = jar2_files - jar1_files
            in_both = jar1_files.intersection(jar2_files)

            differing_files = []
            for filename in in_both:
                if not filename.endswith('/'):
                    hash1 = hash_file_in_zip(z1, filename)
                    hash2 = hash_file_in_zip(z2, filename)
                    if hash1 != hash2:
                        differing_files.append(filename)

            print(f"Comparing:")
            print(f"  [1] {jar1_path}")
            print(f"  [2] {jar2_path}\n")

            if only_in_jar1:
                print(f"{RED}--- Files only in JAR 1 ---{RESET}")
                for f in sorted(only_in_jar1): print(f"{RED}  - {f}{RESET}")
                print()

            if only_in_jar2:
                print(f"{GREEN}--- Files only in JAR 2 ---{RESET}")
                for f in sorted(only_in_jar2): print(f"{GREEN}  + {f}{RESET}")
                print()

            if differing_files:
                print(f"{YELLOW}--- Files with differing content ---{RESET}")
                class_files = []
                for f in sorted(differing_files):
                    if f.endswith('.class'):
                        print(f"{YELLOW}  [CLASS] {f}{RESET}")
                        class_files.append(f)
                    else:
                        print(f"{YELLOW}  [OTHER] {f}{RESET}")
                print()

            # Display actual file contents for new/deleted and modified classes
            with tempfile.TemporaryDirectory() as tmpdir:
                
                # Show contents of files removed
                if only_in_jar1:
                    print(f"{RED}Displaying contents of files removed from JAR 2 (Found only in JAR 1):{RESET}")
                    show_unique_files_content(z1, only_in_jar1, tmpdir, RED, "Deleted")

                # Show contents of files added
                if only_in_jar2:
                    print(f"{GREEN}Displaying contents of files added to JAR 2 (Found only in JAR 2):{RESET}")
                    show_unique_files_content(z2, only_in_jar2, tmpdir, GREEN, "New")

                # Show side-by-side diffs for modified classes
                if class_files:
                    ensure_decompiler()
                    print(f"{YELLOW}Decompiling and comparing Java source code for changed classes...\n{RESET}")
                    for filename in class_files:
                        try:
                            lines1 = extract_and_decompile(z1, filename, tmpdir)
                            lines2 = extract_and_decompile(z2, filename, tmpdir)
                            
                            if lines1 or lines2:
                                print_diff(filename, lines1, lines2)
                            else:
                                print(f"Could not decompile {filename}")
                        except Exception as e:
                            print(f"Error diffing {filename}: {e}")

            if not only_in_jar1 and not only_in_jar2 and not differing_files:
                print("The JAR files have identical contents.")

    except FileNotFoundError as e:
        print(f"Error: {e}")
    except zipfile.BadZipFile as e:
        print(f"Error: Invalid JAR file. {e}")
    except Exception as e:
        print(f"Unexpected error: {e}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python compare_jars.py <path_to_jar_1> <path_to_jar_2>")
        sys.exit(1)
    
    compare_jars(sys.argv[1], sys.argv[2])
