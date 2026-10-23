import { describe, expect, test } from "bun:test";
import { Bm25Index } from "../src/bm25";
import { chunkNote } from "../src/chunker";
import { stem, tokenize } from "../src/tokenize";

function index(notes: Record<string, string>): Bm25Index {
  const idx = new Bm25Index();
  for (const [path, text] of Object.entries(notes)) idx.setNote(path, chunkNote(path, text));
  return idx;
}

describe("tokenize", () => {
  test("lowercases, drops stopwords, folds plurals and accents", () => {
    expect(tokenize("The Outages of the Boxes, café-2025")).toEqual(["outage", "box", "cafe", "2025"]);
    expect(stem("policies")).toBe("policy");
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
  });
});

describe("Bm25Index", () => {
  const notes = {
    "ops/Hetzner SX outage.md": "# Timeline\nThe RAID array degraded after an SSD died.\n# Fix\nReplaced the drive.",
    "cooking/Pasta.md": "# Recipe\nBoil water, add salt, cook pasta.",
    "ops/Backups.md": "Restic backups run nightly to the storage box.",
  };

  test("ranks the relevant note first and boosts titles", () => {
    const idx = index(notes);
    expect(idx.search("raid ssd")[0]?.chunk.path).toBe("ops/Hetzner SX outage.md");
    expect(idx.search("hetzner")[0]?.chunk.path).toBe("ops/Hetzner SX outage.md");
    expect(idx.search("pasta")[0]?.chunk.heading).toBe("Recipe");
    expect(idx.search("nothing-matches-this")).toEqual([]);
  });

  test("updates, removals and renames keep postings consistent", () => {
    const idx = index(notes);
    idx.setNote("cooking/Pasta.md", chunkNote("cooking/Pasta.md", "Now about risotto."));
    expect(idx.search("pasta").map((h) => h.chunk.path)).toEqual(["cooking/Pasta.md"]); // title only
    expect(idx.search("salt")).toEqual([]);
    idx.removeNote("ops/Backups.md");
    expect(idx.search("restic")).toEqual([]);
    expect(idx.noteCount).toBe(2);
    idx.removeNote("ops/Hetzner SX outage.md");
    idx.setNote("ops/Disk.md", chunkNote("ops/Disk.md", "The RAID array degraded."));
    expect(idx.search("raid").map((h) => h.chunk.path)).toEqual(["ops/Disk.md"]);
  });

  test("indexes ~2,000 notes well under 3 s and updates incrementally under 100 ms", () => {
    const words = "server disk network deploy backup kernel cluster invoice meeting travel garden recipe".split(" ");
    const note = (i: number) =>
      Array.from({ length: 6 }, (_, h) =>
        `## Section ${h}\n${Array.from({ length: 120 }, (_, w) => words[(i * 7 + h * 3 + w) % words.length]).join(" ")} note${i}`,
      ).join("\n\n");
    const idx = new Bm25Index();
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) idx.setNote(`n/${i}.md`, chunkNote(`n/${i}.md`, note(i)));
    const build = performance.now() - t0;
    const t1 = performance.now();
    idx.setNote("n/5.md", chunkNote("n/5.md", `${note(5)}\nedited`));
    const update = performance.now() - t1;
    console.log(`2000 notes: build ${build.toFixed(0)} ms, update ${update.toFixed(2)} ms`);
    expect(idx.noteCount).toBe(2000);
    expect(build).toBeLessThan(3000);
    expect(update).toBeLessThan(100);
    expect(idx.search("note1234")[0]?.chunk.path).toBe("n/1234.md");
  });
});
