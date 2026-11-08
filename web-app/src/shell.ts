import { ArrowDownUp, Braces, Flame, FileText, Workflow, type LucideIcon } from 'lucide-react';

// Shared definitions for the workbench shell.

export type Tool = 'home' | 'compare' | 'decompile' | 'profile' | 'markdown' | 'diagram';
export type JvmState = 'loading' | 'ready' | 'error' | 'unavailable';

export const TOOLS: { id: Exclude<Tool, 'home'>; name: string; key: string; Icon: LucideIcon }[] = [
  { id: 'compare', name: 'Compare', key: '1', Icon: ArrowDownUp },
  { id: 'decompile', name: 'Decompile', key: '2', Icon: Braces },
  { id: 'profile', name: 'Profile', key: '3', Icon: Flame },
  { id: 'markdown', name: 'Markdown', key: '4', Icon: FileText },
  { id: 'diagram', name: 'Diagram', key: '5', Icon: Workflow },
];

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Modifier label for shortcuts: ⌘ on Apple platforms, Ctrl+ elsewhere. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';
