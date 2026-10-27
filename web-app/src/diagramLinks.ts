import { createContext } from 'react';

// Links between `code` mentions in the document text and items in rendered diagrams.

export interface DiagramEntry {
  el: HTMLElement;
  /** Keys of items a `code` mention refers to. */
  find: (code: string) => string[];
  /** Temporarily highlight items (hover), or clear with null. */
  preview: (keys: string[] | null) => void;
  /** Select an item, tracing its connections. */
  select: (key: string) => void;
}

export interface DiagramLinkApi {
  register: (e: DiagramEntry) => () => void;
  onSelect: (e: DiagramEntry, key: string | null) => void;
}

export const DiagramLinks = createContext<DiagramLinkApi | null>(null);

/** Writing an edited diagram back into the document. */
export interface DiagramEditApi {
  /** Replace the first mermaid block whose source is `oldCode`; false when it isn't found. */
  replace: (oldCode: string, newCode: string) => boolean;
}

export const DiagramEdit = createContext<DiagramEditApi | null>(null);
