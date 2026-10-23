import { describe, expect, test } from "bun:test";
import { extractJson, parseQueries, parseRerank } from "../src/parse";

describe("extractJson", () => {
  test("handles fences, think blocks and surrounding prose", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('<think>hmm {"no": 1}</think>{"a": 2}')).toEqual({ a: 2 });
    expect(extractJson('Sure! Here you go: [1, "x]"] Hope that helps.')).toEqual([1, "x]"]);
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("parseQueries", () => {
  test("accepts wrapped object, bare array, and plain lines", () => {
    expect(parseQueries('{"queries": ["drive failure", "RAID degraded", "server outage"]}')).toEqual([
      "drive failure",
      "RAID degraded",
      "server outage",
    ]);
    expect(parseQueries('["a b", "A B", "c"]')).toEqual(["a b", "c"]);
    expect(parseQueries('{"keywords": [{"query": "x"}, "y"]}')).toEqual(["x", "y"]);
    expect(parseQueries("1. disk failure\n2. server outage\n- hosting provider")).toEqual([
      "disk failure",
      "server outage",
      "hosting provider",
    ]);
    expect(parseQueries('["1","2","3","4","5","6","7"]')).toHaveLength(5);
  });
});

describe("parseRerank", () => {
  test("accepts bare array and wrapped results", () => {
    const bare = parseRerank('[{"path": "a.md", "score": 90, "reason": "exact"}]');
    expect(bare).toEqual([{ path: "a.md", score: 90, reason: "exact" }]);
    const wrapped = parseRerank('```json\n{"results": [{"id": "2", "path": "b.md", "score": "75", "reason": "close"}]}\n```');
    expect(wrapped).toEqual([{ path: "b.md", score: 75, reason: "close", id: 2 }]);
  });

  test("normalises scores and tolerates odd shapes", () => {
    const items = parseRerank('{"ranking": [{"note": "a.md", "relevance": 0.83}, {"path": "b.md", "score": 250}, {"foo": 1}]}');
    expect(items).toEqual([
      { path: "a.md", score: 83, reason: "" },
      { path: "b.md", score: 100, reason: "" },
    ]);
    expect(parseRerank('{"path": "only.md", "score": 60, "reason": "single"}')).toHaveLength(1);
    expect(parseRerank('{"results": []}')).toEqual([]);
  });

  test("salvages complete objects from a truncated reply", () => {
    const truncated = '{"results": [{"id": 1, "path": "a.md", "score": 90, "reason": "x"}, {"id": 2, "path": "b.md", "sco';
    expect(parseRerank(truncated)).toEqual([{ path: "a.md", score: 90, reason: "x", id: 1 }]);
    expect(() => parseRerank("I could not decide.")).toThrow();
  });
});
