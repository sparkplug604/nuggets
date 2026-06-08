import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Nugget } from "../src/nuggets/memory.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nuggets-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Nugget", () => {
  it("remembers and recalls a fact", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false });
    n.remember("color", "blue", { source: "test" });
    const result = n.recall("color");
    expect(result.found).toBe(true);
    expect(result.answer).toBe("blue");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.top_k[0].answer).toBe("blue");
    expect(result.capacity_pressure).toBeGreaterThan(0);
    expect(n.facts()[0].source).toBe("test");
  });

  it("upserts on duplicate key", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false });
    n.remember("color", "blue");
    n.remember("color", "red");
    expect(n.facts()).toHaveLength(1);
    expect(n.facts()[0].previous_values).toContain("blue");
    expect(n.facts()[0].promotion_state).toBe("quarantined");
    const result = n.recall("color");
    expect(result.answer).toBe("red");
  });

  it("forgets a fact", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false });
    n.remember("color", "blue");
    expect(n.forget("color")).toBe(true);
    expect(n.facts()).toHaveLength(0);
    expect(n.forget("nonexistent")).toBe(false);
  });

  it("clears all facts", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false });
    n.remember("a", "1");
    n.remember("b", "2");
    n.clear();
    expect(n.facts()).toHaveLength(0);
  });

  it("returns correct status", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false });
    n.remember("a", "1");
    const s = n.status();
    expect(s.name).toBe("test");
    expect(s.fact_count).toBe(1);
    expect(s.dimension).toBe(512);
    expect(s.banks).toBe(2);
  });

  it("saves and loads from JSON", () => {
    const n = new Nugget({ name: "persist", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("lang", "typescript");
    n.remember("color", "green");
    const path = n.save();

    const loaded = Nugget.load(path, { autoSave: false });
    expect(loaded.name).toBe("persist");
    expect(loaded.facts()).toHaveLength(2);

    const result = loaded.recall("lang");
    expect(result.found).toBe(true);
    expect(result.answer).toBe("typescript");
  });

  it("tracks hit counts per session", () => {
    const n = new Nugget({ name: "hits", D: 512, banks: 2, autoSave: false });
    n.remember("key", "value");

    n.recall("key", "session-1");
    n.recall("key", "session-1"); // duplicate — should not increment
    expect(n.facts()[0].hits).toBe(1);

    n.recall("key", "session-2");
    expect(n.facts()[0].hits).toBe(2);
  });

  it("enforces max_facts limit", () => {
    const n = new Nugget({ name: "limited", D: 512, banks: 2, autoSave: false, maxFacts: 3 });
    n.remember("a", "1");
    n.remember("b", "2");
    n.remember("c", "3");
    n.remember("d", "4"); // should evict "a"
    expect(n.facts()).toHaveLength(3);
    expect(n.facts().map((f) => f.key)).toEqual(["b", "c", "d"]);
  });

  it("handles multiple facts with distinct values", () => {
    const n = new Nugget({ name: "multi", D: 1024, banks: 4, autoSave: false });
    n.remember("name", "Alice");
    n.remember("pet", "cat");
    n.remember("city", "London");

    const r1 = n.recall("name");
    expect(r1.found).toBe(true);
    expect(r1.answer).toBe("Alice");

    const r2 = n.recall("pet");
    expect(r2.found).toBe(true);
    expect(r2.answer).toBe("cat");

    const r3 = n.recall("city");
    expect(r3.found).toBe(true);
    expect(r3.answer).toBe("London");
  });

  it("fuzzy matches keys", () => {
    const n = new Nugget({ name: "fuzzy", D: 512, banks: 2, autoSave: false });
    n.remember("favorite color", "blue");

    // Substring match
    const r = n.recall("color");
    expect(r.found).toBe(true);
    expect(r.answer).toBe("blue");
  });

  it("returns not-found for unknown queries", () => {
    const n = new Nugget({ name: "empty", D: 512, banks: 2, autoSave: false });
    const result = n.recall("anything");
    expect(result.found).toBe(false);
    expect(result.answer).toBeNull();
  });

  it("matches natural language queries by token overlap", () => {
    const n = new Nugget({ name: "nl", D: 1024, banks: 4, autoSave: false });
    n.remember("deploy-process", "git push to main triggers vercel");
    n.remember("python-version", "3.11.9");
    n.remember("favorite-food", "cheese strings");

    expect(n.recall("how to deploy").answer).toBe("git push to main triggers vercel");
    expect(n.recall("which python version").answer).toBe("3.11.9");
    expect(n.recall("what food do they like").answer).toBe("cheese strings");
  });

  it("still avoids false positives for unrelated natural language", () => {
    const n = new Nugget({ name: "nl-safe", D: 1024, banks: 4, autoSave: false });
    n.remember("deploy-process", "git push to main triggers vercel");
    n.remember("favorite-food", "cheese strings");

    const result = n.recall("weather forecast tomorrow");
    expect(result.found).toBe(false);
  });

  it("ignores empty key/value on remember", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false });
    n.remember("", "value");
    n.remember("key", "");
    n.remember("  ", "value");
    expect(n.facts()).toHaveLength(0);
  });

  it("abstains when an overloaded memory has high-entropy recall", () => {
    const n = new Nugget({ name: "overloaded", D: 256, banks: 1, autoSave: false });
    for (let i = 0; i < 128; i++) {
      n.remember(`key-${i}`, `value-${i}`);
    }

    const result = n.recall("key-64");
    expect(result.found).toBe(false);
    expect(result.abstained).toBe(true);
    expect(result.reason).toBe("capacity_pressure");
    expect(result.top_k.length).toBeGreaterThan(1);
  });

  it("can return uncertain recall diagnostics when abstention is disabled", () => {
    const n = new Nugget({ name: "diagnostics", D: 256, banks: 1, autoSave: false });
    for (let i = 0; i < 128; i++) {
      n.remember(`key-${i}`, `value-${i}`);
    }

    const result = n.recall("key-64", "", { abstainOnUncertainty: false });
    expect(result.found).toBe(true);
    expect(result.abstained).toBe(false);
    expect(result.reason).toBe("capacity_pressure");
    expect(result.capacity_pressure).toBeGreaterThan(1);
  });
});
