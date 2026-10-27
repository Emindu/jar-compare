// Classifying and naming frames for the Profile view, and flame-graph layout.

import type { FlameNode } from './jfr';

export type FrameCategory = 'app' | 'lib' | 'jdk';

const JDK = /^(java|javax|jdk|sun|com\.sun|org\.graalvm|kotlin\.jvm\.internal)\./;
// Common third-party packages; anything else outside the JDK counts as "your code".
const LIBS = [
  'org.springframework.', 'org.apache.', 'com.fasterxml.', 'io.netty.', 'org.hibernate.', 'com.zaxxer.',
  'ch.qos.', 'org.slf4j.', 'kotlin.', 'kotlinx.', 'scala.', 'com.google.', 'io.micrometer.', 'reactor.',
  'org.eclipse.', 'org.jboss.', 'net.bytebuddy.', 'okhttp3.', 'okio.', 'com.mysql.', 'org.postgresql.',
  'org.h2.', 'io.grpc.', 'com.lowagie.', 'org.glassfish.', 'io.undertow.', 'org.xnio.', 'com.mongodb.',
  'redis.', 'io.lettuce.', 'org.mockito.', 'org.junit.', 'io.vertx.', 'io.quarkus.', 'io.micronaut.',
  'com.amazonaws.', 'software.amazon.', 'org.yaml.', 'org.jooq.', 'org.flywaydb.', 'org.liquibase.',
  'com.github.benmanes.', 'org.objectweb.', 'org.codehaus.', 'javassist.', 'feign.', 'io.opentelemetry.',
];

export function categoryOf(name: string): FrameCategory {
  if (name === 'all') return 'jdk';
  if (JDK.test(name) || !name.includes('.')) return 'jdk';
  if (LIBS.some((p) => name.startsWith(p))) return 'lib';
  return 'app';
}

/** "com.acme.orders.tax.TaxTable.rateFor" → { short: "TaxTable.rateFor", pkg: "com.acme.orders.tax" }. */
export function splitName(fqn: string): { short: string; pkg: string } {
  const parts = fqn.split('.');
  if (parts.length < 3) return { short: fqn, pkg: '' };
  return { short: parts.slice(-2).join('.'), pkg: parts.slice(0, -2).join('.') };
}

export function fmtDuration(nanos: number): string {
  if (!nanos || nanos < 0) return '–';
  const s = nanos / 1e9;
  if (s < 1) return `${Math.round(nanos / 1e6)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export const FLAME_ROW = 24; // px per stack depth
const ROW = FLAME_ROW;

export interface Cell { node: FlameNode; path: string[]; depth: number; x: number; w: number }

export function layout(focus: FlameNode, focusPath: string[]): { cells: Cell[]; maxDepth: number } {
  const cells: Cell[] = [];
  let maxDepth = 0;
  const total = focus.value || 1;
  const walk = (node: FlameNode, path: string[], depth: number, x: number) => {
    const w = node.value / total;
    if (w < 0.0015 && depth > 0) return; // too thin to see
    cells.push({ node, path, depth, x, w });
    if (depth > maxDepth) maxDepth = depth;
    let cx = x;
    for (const c of node.children) {
      walk(c, [...path, c.name], depth + 1, cx);
      cx += c.value / total;
    }
  };
  walk(focus, focusPath, 0, 0);
  return { cells, maxDepth };
}

export const samePath = (a: string[] | null, b: string[] | null) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The flame graph of `focus` as a standalone SVG document. */
export function flameSvg(focus: FlameNode, focusPath: string[], total: number, dark: boolean): string {
  const W = 1200;
  const { cells, maxDepth } = layout(focus, focusPath);
  const H = (maxDepth + 1) * ROW + 40;
  const fill = { app: '#E8894A', lib: '#4A6FA5', jdk: dark ? '#4B5260' : '#AEB6C2' } as const;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = cells.map((c) => {
    const x = c.x * W, w = Math.max(c.w * W - 1, 0.5), y = c.depth * ROW + 30;
    const label = splitName(c.node.name).short;
    const fit = Math.floor((w - 8) / 7);
    const text = fit > 2 ? esc(label.length > fit ? label.slice(0, fit - 1) + '…' : label) : '';
    const pct = ((c.node.value / total) * 100).toFixed(1);
    return `<g><title>${esc(c.node.name)} · ${c.node.value} samples (${pct}%)</title>`
      + `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${ROW - 2}" rx="2" fill="${fill[categoryOf(c.node.name)]}"/>`
      + (text ? `<text x="${(x + 5).toFixed(1)}" y="${y + 15}">${text}</text>` : '') + '</g>';
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="IBM Plex Mono, ui-monospace, monospace" font-size="12">
<rect width="100%" height="100%" fill="${dark ? '#0F1216' : '#FAFBFC'}"/>
<text x="0" y="18" fill="${dark ? '#9BA3AF' : '#57606A'}">${esc(focusPath.join(' › '))} · ${focus.value} samples</text>
<g fill="#fff">${rows}</g>
</svg>`;
}

