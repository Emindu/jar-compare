# jar-compare

A **client-side JAR comparison tool**. Pick two Java `.jar` files and see
exactly what changed between them — added, removed, and modified entries,
with a readable **source-level diff** of changed classes.

Everything runs **inside your browser**. The Java comparison engine executes
via WebAssembly (CheerpJ), so your JARs are never uploaded to a server.

🔗 **Live app:** https://emindu.github.io/jar-compare/

---

## Features

- 📦 **Compare two JARs** entirely in the browser — drag & drop or browse.
- 🔍 **Source-level diffs** — changed `.class` files are decompiled (via CFR)
  so you see readable Java, not bytecode, side by side.
- 🪆 **Nested JAR support** — recurses into JARs packaged inside JARs
  (fat/uber JARs).
- 🧮 **Accurate change detection** — every entry is SHA-256 hashed to classify
  added / removed / modified.
- 🧠 **"Identical source" detection** — flags classes whose bytecode differs
  but whose decompiled source is identical (e.g. recompiled with a different
  compiler or line-number changes).
- 🌗 **Light / dark theme** — defaults to light; your choice is remembered.
- 🔒 **Private by design** — no backend, no uploads; just static files.

---

## How it works (in one picture)

```
Browser tab
└── React + TypeScript UI
    └── CheerpJ  (a Java Virtual Machine compiled to WebAssembly)
        └── webcomparer.jar  (the comparison engine)
            └── reads your two JARs, diffs + decompiles, returns JSON
```

The UI hands the two selected JARs to an in-browser JVM, runs the Java
engine over them, and renders the JSON result it prints back.

📖 **Full details:** see [`ARCHITECTURE.md`](./ARCHITECTURE.md) — includes a
beginner-friendly WebAssembly explainer and diagrams of the runtime,
the Java engine, and the build/deploy pipeline.

---

## Project structure

```
jar-compare/
├── web-app/                      # Front-end (React + Vite) — this is what's deployed
│   ├── public/webcomparer.jar    # Prebuilt Java engine (served as a static asset)
│   └── src/App.tsx               # Boots CheerpJ, feeds JARs, renders the diff
├── jar-compare-java/             # Java engine source (built separately with Maven)
│   └── src/main/java/com/jarcompare/
│       ├── WebJarComparer.java   # Entry point used by the web app
│       └── JarComparer.java      # Stand-alone CLI variant
├── compare_jars.py               # Python helper / reference implementation
└── .github/workflows/            # Builds web-app and deploys to GitHub Pages
```

---

## Running locally

The deployed app is just the front-end in `web-app/`.

```bash
cd web-app
npm install
npm run dev        # start the Vite dev server
npm run build      # production build into web-app/dist
npm run preview    # preview the production build
```

Then open the printed local URL.

---

## Rebuilding the Java engine

`web-app/public/webcomparer.jar` is a **prebuilt artifact checked into git**.
The deploy workflow does *not* recompile it. If you change anything under
`jar-compare-java/`, rebuild and re-commit the JAR:

```bash
cd jar-compare-java
mvn clean package
# copy the shaded/uber jar into the web app's public folder:
cp target/<your-shaded-jar>.jar ../web-app/public/webcomparer.jar
```

The Maven build (see `pom.xml`) uses the **shade** plugin to bundle the
engine's dependencies — **Gson** (JSON output) and **CFR** (decompiler) —
into a single self-contained JAR.

---

## Deployment

Pushing to `main` triggers the GitHub Actions workflow in
`.github/workflows/`, which:

1. builds `web-app/` (`npm ci && npm run build`, with Vite `base: '/jar-compare/'`),
2. uploads `web-app/dist/` (including `webcomparer.jar`) as a Pages artifact, and
3. publishes it to GitHub Pages.

Requires **Settings → Pages → Source = "GitHub Actions"**.

---

## Tech stack

| Layer | Technology |
|---|---|
| UI | React 19, TypeScript, Vite |
| Diff view | `react-diff-viewer-continued` |
| In-browser JVM | CheerpJ 4.3 (WebAssembly) |
| Comparison engine | Java — SHA-256 diffing + CFR decompilation |
| JSON | Gson |
| Hosting | GitHub Pages (static) |
