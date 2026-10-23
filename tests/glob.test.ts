import { expect, test } from "bun:test";
import { compileExcludes } from "../src/glob";

test("exclusion globs", () => {
  const excluded = compileExcludes(["Templates", "Archive/**", "**/drafts/*", "*.excalidraw.md", ""]);
  expect(excluded("Templates/Daily.md")).toBe(true);
  expect(excluded("Templates")).toBe(true);
  expect(excluded("TemplatesX/a.md")).toBe(false);
  expect(excluded("Archive/2020/x.md")).toBe(true);
  expect(excluded("drafts/a.md")).toBe(true);
  expect(excluded("blog/drafts/a.md")).toBe(true);
  expect(excluded("blog/drafts/deep/a.md")).toBe(false);
  expect(excluded("Drawing.excalidraw.md")).toBe(true);
  expect(excluded("notes/Drawing.excalidraw.md")).toBe(false);
  expect(excluded("Notes/a.md")).toBe(false);
  expect(compileExcludes([])("anything.md")).toBe(false);
});
