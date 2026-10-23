import { describe, expect, test } from "bun:test";
import { chunkNote, noteTitle } from "../src/chunker";

describe("chunkNote", () => {
  test("splits by heading and records heading + line", () => {
    const md = "Intro text\n\n# First\nalpha\n\n## Second\nbeta\n";
    const chunks = chunkNote("dir/Note.md", md);
    expect(chunks.map((c) => [c.heading, c.line])).toEqual([
      [null, 0],
      ["First", 2],
      ["Second", 5],
    ]);
    expect(chunks[1]?.text).toBe("# First\nalpha");
    expect(chunks.every((c) => c.title === "Note" && c.path === "dir/Note.md")).toBe(true);
  });

  test("ignores headings inside code fences and frontmatter", () => {
    const md = "---\ntags: [ops]\n# not a heading\n---\n# Real\n```sh\n# comment\n```\n";
    const chunks = chunkNote("a.md", md);
    expect(chunks.map((c) => c.heading)).toEqual([null, "Real"]);
    expect(chunks[0]?.text).toContain("tags: [ops]");
    expect(chunks[1]?.text).toContain("# comment");
  });

  test("windows heading-less notes at ~800 chars", () => {
    const para = "lorem ipsum dolor sit amet ".repeat(10).trim();
    const md = Array.from({ length: 20 }, () => para).join("\n\n");
    const chunks = chunkNote("long.md", md);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.heading).toBeNull();
      expect(c.text.length).toBeLessThanOrEqual(1100);
    }
    expect(chunks[1]!.line).toBeGreaterThan(0);
  });

  test("oversized heading sections are windowed but keep the heading", () => {
    const md = `# Big\n${"word ".repeat(100)}\n`.repeat(1) + Array.from({ length: 10 }, () => "x ".repeat(150)).join("\n");
    const chunks = chunkNote("big.md", md);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === "Big")).toBe(true);
  });

  test("hard-splits a single huge line", () => {
    const chunks = chunkNote("blob.md", "token ".repeat(1000));
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.text.length <= 800)).toBe(true);
  });

  test("empty notes produce no chunks", () => {
    expect(chunkNote("e.md", "\n\n  \n")).toEqual([]);
  });

  test("noteTitle strips folders and extension", () => {
    expect(noteTitle("a/b/Hetzner SX outage 2025-03.md")).toBe("Hetzner SX outage 2025-03");
  });
});
