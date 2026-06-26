// ── Pure-TypeScript Java Flight Recorder (.jfr) parser ─────────────────────
//
// Decodes the JFR chunked binary format (JDK 9+, format v1/v2) entirely in the
// browser — no JVM, no server. We parse just enough to drive a profiler view:
// the type system (metadata event), constant pools (checkpoint events) and the
// execution-sample events, from which we build a flame graph and hot-method
// table.
//
// Format reference: each file is a sequence of self-contained *chunks*. A chunk
// begins with a 68-byte big-endian header, followed by a stream of events. Two
// event kinds are special: the *metadata* event (typeId 0) describes every
// type, and *checkpoint* events (typeId 1) carry the constant pools. All other
// integers in the body use JFR's LEB128-style "compressed integer" varints.

export interface JfrFrame {
  method: string;
  line: number;
}

export interface FlameNode {
  name: string;
  value: number;          // total samples through this node
  self: number;           // samples where this node is the leaf
  children: FlameNode[];
}

export interface HotMethod {
  name: string;
  self: number;           // samples where this method is on top of the stack
  total: number;          // samples where this method appears anywhere
}

export interface JfrResult {
  version: string;
  chunks: number;
  totalSamples: number;
  startNanos: number;
  durationNanos: number;
  threads: string[];
  eventCounts: { name: string; count: number }[];
  hot: HotMethod[];
  flame: FlameNode;
}

// ── Low-level cursor over the byte buffer ──────────────────────────────────
class Reader {
  view: DataView;
  bytes: Uint8Array;
  pos = 0;
  private dec = new TextDecoder('utf-8');

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.bytes = new Uint8Array(buf);
  }

  u1(): number { return this.bytes[this.pos++]; }
  i1(): number { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u2(): number { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i4(): number { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  f4(): number { const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
  f8(): number { const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }

  // Fixed-width big-endian 64-bit (header fields). Returns a JS number; values
  // beyond 2^53 (epoch nanos) lose low-order precision, which is fine here.
  i8(): number {
    const hi = this.view.getUint32(this.pos);
    const lo = this.view.getUint32(this.pos + 4);
    this.pos += 8;
    return hi * 4294967296 + lo;
  }

  // JFR compressed integer: up to 8 groups of 7 bits (high bit = continue),
  // then an optional 9th byte carrying a full 8 bits.
  v(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.bytes[this.pos++];
      result += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) return result;
      mul *= 128;
    }
    result += this.bytes[this.pos++] * mul;
    return result;
  }

  // JFR string encodings: 0 null, 1 empty, 2 string-pool ref, 3 UTF-8,
  // 4 char-array, 5 Latin-1.
  str(): string | { poolStr: number } | null {
    const enc = this.bytes[this.pos++];
    switch (enc) {
      case 0: return null;
      case 1: return '';
      case 2: return { poolStr: this.v() };
      case 3: { const n = this.v(); const s = this.dec.decode(this.bytes.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
      case 4: { const n = this.v(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.v()); return s; }
      case 5: { const n = this.v(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos++]); return s; }
      default: return null;
    }
  }
}

// ── Type system (from the metadata event) ──────────────────────────────────
interface FieldDef { name: string; typeId: number; constantPool: boolean; array: boolean; }
interface TypeDef { id: number; name: string; fields: FieldDef[]; }
interface Element { name: string; attrs: Record<string, string>; children: Element[]; }

type Ref = { ref: number; idx: number };
const isRef = (v: unknown): v is Ref =>
  typeof v === 'object' && v !== null && typeof (v as Ref).ref === 'number';

// Reader names for the built-in primitive types; everything else is a struct.
const PRIMITIVES = new Set([
  'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'java.lang.String',
]);

function readElement(r: Reader, strings: string[]): Element {
  const name = strings[r.v()];
  const attrs: Record<string, string> = {};
  const attrCount = r.v();
  for (let i = 0; i < attrCount; i++) {
    const k = strings[r.v()];
    const val = strings[r.v()];
    attrs[k] = val;
  }
  const children: Element[] = [];
  const childCount = r.v();
  for (let i = 0; i < childCount; i++) children.push(readElement(r, strings));
  return { name, attrs, children };
}

function parseMetadata(r: Reader, offset: number, types: Map<number, TypeDef>): void {
  r.pos = offset;
  r.v();            // size
  r.v();            // typeId (0)
  r.v();            // startTime
  r.v();            // duration
  r.v();            // metadataId
  const strCount = r.v();
  const strings: string[] = new Array(strCount);
  for (let i = 0; i < strCount; i++) {
    const s = r.str();
    strings[i] = typeof s === 'string' ? s : '';
  }
  const root = readElement(r, strings);
  const visit = (e: Element) => {
    if (e.name === 'class') {
      const id = Number(e.attrs['id']);
      const fields: FieldDef[] = [];
      for (const c of e.children) {
        if (c.name !== 'field') continue;
        fields.push({
          name: c.attrs['name'],
          typeId: Number(c.attrs['class']),
          constantPool: c.attrs['constantPool'] === 'true',
          array: c.attrs['dimension'] !== undefined,
        });
      }
      types.set(id, { id, name: e.attrs['name'], fields });
    }
    for (const c of e.children) visit(c);
  };
  visit(root);
}

// ── Value reading (driven by the type system) ──────────────────────────────
function readValue(r: Reader, type: TypeDef, types: Map<number, TypeDef>): any {
  if (PRIMITIVES.has(type.name)) return readPrimitive(r, type.name);
  const obj: Record<string, any> = {};
  for (const f of type.fields) obj[f.name] = readField(r, f, types);
  return obj;
}

function readField(r: Reader, f: FieldDef, types: Map<number, TypeDef>): any {
  if (f.array) {
    const n = r.v();
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = readScalar(r, f, types);
    return arr;
  }
  return readScalar(r, f, types);
}

function readScalar(r: Reader, f: FieldDef, types: Map<number, TypeDef>): any {
  if (f.constantPool) return { ref: f.typeId, idx: r.v() };
  const ft = types.get(f.typeId);
  if (!ft) return null;
  if (PRIMITIVES.has(ft.name)) return readPrimitive(r, ft.name);
  return readValue(r, ft, types);
}

function readPrimitive(r: Reader, name: string): any {
  switch (name) {
    case 'boolean': return r.u1() !== 0;
    case 'byte': return r.i1();
    case 'char': return r.v();
    case 'short': return r.v();
    case 'int': return r.v();
    case 'long': return r.v();
    case 'float': return r.f4();
    case 'double': return r.f8();
    case 'java.lang.String': return r.str();
    default: return null;
  }
}

// ── Chunk walking ──────────────────────────────────────────────────────────
type Pools = Map<number, Map<number, any>>;

function walkEvents(
  r: Reader,
  start: number,
  end: number,
  cb: (typeId: number) => void,
): void {
  let pos = start;
  while (pos < end) {
    r.pos = pos;
    const size = r.v();
    if (size <= 0) break;
    const typeId = r.v();
    cb(typeId);                 // cb may read further; we advance by size
    pos += size;
  }
}

function parseCheckpoint(r: Reader, types: Map<number, TypeDef>, pools: Pools): void {
  r.v();        // startTime
  r.v();        // duration
  r.v();        // delta
  r.u1();       // flush / typeMask
  const poolCount = r.v();
  for (let p = 0; p < poolCount; p++) {
    const typeId = r.v();
    const count = r.v();
    let pool = pools.get(typeId);
    if (!pool) { pool = new Map(); pools.set(typeId, pool); }
    const t = types.get(typeId);
    for (let i = 0; i < count; i++) {
      const key = r.v();
      pool.set(key, t ? readValue(r, t, types) : null);
    }
  }
}

// ── Constant-pool resolution helpers ───────────────────────────────────────
function poolGet(pools: Pools, ref: Ref): any {
  const m = pools.get(ref.ref);
  return m ? m.get(ref.idx) : undefined;
}

function resolveStr(v: any, pools: Pools, stringTypeId: number | undefined): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.poolStr === 'number' && stringTypeId !== undefined) {
    const m = pools.get(stringTypeId);
    const s = m ? m.get(v.poolStr) : undefined;
    return typeof s === 'string' ? s : null;
  }
  return null;
}

// A Symbol is a struct { string }, possibly reached through a ref.
function symbolStr(ref: any, pools: Pools, stringTypeId: number | undefined): string | null {
  if (ref == null) return null;
  if (isRef(ref)) return symbolStr(poolGet(pools, ref), pools, stringTypeId);
  if (typeof ref === 'object' && 'string' in ref) return resolveStr(ref.string, pools, stringTypeId);
  return resolveStr(ref, pools, stringTypeId);
}

function resolveStack(
  stRef: Ref,
  pools: Pools,
  stringTypeId: number | undefined,
): JfrFrame[] {
  const st = poolGet(pools, stRef);
  if (!st || !Array.isArray(st.frames)) return [];
  const out: JfrFrame[] = [];
  for (const fr of st.frames) {
    let label = '<unknown>';
    const m = isRef(fr.method) ? poolGet(pools, fr.method) : null;
    if (m) {
      const cls = isRef(m.type) ? poolGet(pools, m.type) : null;
      const clsName = cls ? symbolStr(cls.name, pools, stringTypeId) : null;
      const mName = symbolStr(m.name, pools, stringTypeId) || '?';
      label = (clsName ? clsName.replace(/\//g, '.') + '.' : '') + mName;
    }
    out.push({ method: label, line: typeof fr.lineNumber === 'number' ? fr.lineNumber : 0 });
  }
  return out;
}

// ── Aggregation into flame tree + hot methods ──────────────────────────────
interface MutNode { name: string; value: number; self: number; children: Map<string, MutNode>; }

class Aggregator {
  root: MutNode = { name: 'all', value: 0, self: 0, children: new Map() };
  hotSelf = new Map<string, number>();
  hotTotal = new Map<string, number>();
  eventCounts = new Map<string, number>();
  threads = new Set<string>();
  total = 0;

  countEvent(name: string): void {
    this.eventCounts.set(name, (this.eventCounts.get(name) || 0) + 1);
  }

  addSample(frames: JfrFrame[], thread: string | null): void {
    if (!frames.length) return;
    this.total++;
    if (thread) this.threads.add(thread);
    let node = this.root;
    node.value++;
    const seen = new Set<string>();
    // Frames are leaf-first; walk outermost→innermost for a top-down tree.
    for (let i = frames.length - 1; i >= 0; i--) {
      const name = frames[i].method;
      let child = node.children.get(name);
      if (!child) { child = { name, value: 0, self: 0, children: new Map() }; node.children.set(name, child); }
      child.value++;
      node = child;
      if (!seen.has(name)) { seen.add(name); this.hotTotal.set(name, (this.hotTotal.get(name) || 0) + 1); }
    }
    node.self++;
    const leaf = frames[0].method;
    this.hotSelf.set(leaf, (this.hotSelf.get(leaf) || 0) + 1);
  }

  flame(): FlameNode {
    const conv = (n: MutNode): FlameNode => ({
      name: n.name,
      value: n.value,
      self: n.self,
      children: [...n.children.values()].sort((a, b) => b.value - a.value).map(conv),
    });
    return conv(this.root);
  }

  hotMethods(): HotMethod[] {
    const names = new Set<string>([...this.hotSelf.keys(), ...this.hotTotal.keys()]);
    const out: HotMethod[] = [];
    for (const name of names) {
      out.push({ name, self: this.hotSelf.get(name) || 0, total: this.hotTotal.get(name) || 0 });
    }
    out.sort((a, b) => b.self - a.self || b.total - a.total);
    return out;
  }
}

// ── Public entry point ─────────────────────────────────────────────────────
export function parseJfr(buf: ArrayBuffer): JfrResult {
  const r = new Reader(buf);
  const agg = new Aggregator();
  let pos = 0;
  let chunks = 0;
  let version = '';
  let startNanos = 0;
  let durationNanos = 0;

  while (pos + 68 <= r.bytes.length) {
    // Magic "FLR\0"
    if (!(r.bytes[pos] === 0x46 && r.bytes[pos + 1] === 0x4c && r.bytes[pos + 2] === 0x52 && r.bytes[pos + 3] === 0x00)) {
      if (chunks === 0) throw new Error('Not a JFR file (missing FLR magic).');
      break;
    }
    r.pos = pos + 4;
    const major = r.u2();
    const minor = r.u2();
    const chunkSize = r.i8();
    const cpOffset = r.i8();           // (unused: we scan the body for checkpoints)
    const metaOffset = r.i8();
    const cStart = r.i8();
    const cDuration = r.i8();
    void cpOffset;

    if (chunks === 0) { version = `${major}.${minor}`; startNanos = cStart; }
    durationNanos += cDuration;

    const bodyStart = pos + 68;
    const chunkEnd = pos + chunkSize;
    if (chunkSize <= 0 || chunkEnd > r.bytes.length) break;

    // 1. Type system from the metadata event.
    const types = new Map<number, TypeDef>();
    parseMetadata(r, pos + metaOffset, types);

    const idByName = new Map<string, number>();
    const nameById = new Map<number, string>();
    for (const t of types.values()) { idByName.set(t.name, t.id); nameById.set(t.id, t.name); }
    const stringTypeId = idByName.get('java.lang.String');

    // 2. Constant pools (checkpoint events) — needs the type system in hand.
    const pools: Pools = new Map();
    walkEvents(r, bodyStart, chunkEnd, (typeId) => {
      if (typeId === 1) parseCheckpoint(r, types, pools);
    });

    // 3. Data events: count everything, decode execution samples.
    const sampleIds = new Set<number>();
    for (const n of ['jdk.ExecutionSample', 'jdk.NativeMethodSample']) {
      const id = idByName.get(n);
      if (id !== undefined) sampleIds.add(id);
    }
    walkEvents(r, bodyStart, chunkEnd, (typeId) => {
      if (typeId === 0 || typeId === 1) return;
      agg.countEvent(nameById.get(typeId) || `type#${typeId}`);
      if (!sampleIds.has(typeId)) return;
      const t = types.get(typeId)!;
      const ev = readValue(r, t, types);
      if (!isRef(ev.stackTrace)) return;
      const frames = resolveStack(ev.stackTrace, pools, stringTypeId);
      let thread: string | null = null;
      if (isRef(ev.sampledThread)) {
        const th = poolGet(pools, ev.sampledThread);
        if (th) thread = resolveStr(th.javaName, pools, stringTypeId) || resolveStr(th.osName, pools, stringTypeId);
      }
      agg.addSample(frames, thread);
    });

    pos += chunkSize;
    chunks++;
  }

  const eventCounts = [...agg.eventCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    version,
    chunks,
    totalSamples: agg.total,
    startNanos,
    durationNanos,
    threads: [...agg.threads].sort(),
    eventCounts,
    hot: agg.hotMethods(),
    flame: agg.flame(),
  };
}
