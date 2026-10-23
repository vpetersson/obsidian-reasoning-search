export interface Chunk {
  /** Vault-relative path of the note. */
  path: string;
  /** Note basename without extension. */
  title: string;
  /** Nearest heading text, or null for the preamble / heading-less windows. */
  heading: string | null;
  /** 0-based line where the chunk starts, used to scroll the editor there. */
  line: number;
  text: string;
}

export interface ChunkOptions {
  /** Target size for fallback windows. */
  windowSize: number;
  /** Heading sections longer than this are split into windows that keep the heading. */
  maxSectionSize: number;
}

const DEFAULTS: ChunkOptions = { windowSize: 800, maxSectionSize: 1600 };
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function noteTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

interface Section {
  heading: string | null;
  line: number;
  lines: string[];
}

/** Split a markdown note into chunks by heading, falling back to ~windowSize character windows. */
export function chunkNote(path: string, content: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const title = noteTitle(path);
  const lines = content.split(/\r?\n/);

  // Skip YAML frontmatter for heading detection, but keep it as searchable text (tags, aliases).
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) start = end + 1;
  }

  const sections: Section[] = [{ heading: null, line: 0, lines: lines.slice(0, start) }];
  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m?.[2]) {
      sections.push({ heading: m[2], line: i, lines: [line] });
    } else {
      sections[sections.length - 1]?.lines.push(line);
    }
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n");
    if (!text.trim()) continue;
    if (text.length <= opts.maxSectionSize && section.heading !== null) {
      chunks.push({ path, title, heading: section.heading, line: section.line, text: text.trim() });
      continue;
    }
    // Heading-less text (or an oversized section) gets windowed.
    for (const w of windows(section.lines, section.line, opts.windowSize)) {
      chunks.push({ path, title, heading: section.heading, line: w.line, text: w.text });
    }
  }
  return chunks;
}

function windows(lines: string[], firstLine: number, size: number): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let bufLine = firstLine;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ line: bufLine, text });
    buf = [];
    bufLen = 0;
  };
  lines.forEach((line, i) => {
    if (bufLen === 0) bufLine = firstLine + i;
    if (line.length > size * 2) {
      // A single huge line (pasted blob): hard-split it on whitespace.
      flush();
      for (let pos = 0; pos < line.length; ) {
        let end = Math.min(line.length, pos + size);
        const space = line.lastIndexOf(" ", end);
        if (end < line.length && space > pos + size / 2) end = space;
        const text = line.slice(pos, end).trim();
        if (text) out.push({ line: firstLine + i, text });
        pos = end;
      }
      return;
    }
    buf.push(line);
    bufLen += line.length + 1;
    // Break at the target size, or earlier at a paragraph boundary once we're most of the way there.
    if (bufLen >= size || (bufLen >= size * 0.75 && line.trim() === "")) flush();
  });
  flush();
  return out;
}
