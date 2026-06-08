import { describe, it, expect } from "vitest";
import { NuggetShelf } from "../src/nuggets/shelf.js";
import { buildPromotionLedger } from "../src/nuggets/promote.js";

function shelfWithFact(opts?: { source?: string; expiresAt?: string; value?: string }) {
  const shelf = new NuggetShelf({ autoSave: false });
  const nugget = shelf.getOrCreate("project");
  nugget.remember("test-command", opts?.value ?? "npm test", {
    source: opts?.source,
    expiresAt: opts?.expiresAt,
    confidence: 0.9,
  });
  nugget.recall("test-command", "session-1");
  nugget.recall("test-command", "session-2");
  nugget.recall("test-command", "session-3");
  return { shelf, nugget };
}

describe("promotion ledger", () => {
  it("promotes facts with enough hits and recall quality", () => {
    const { shelf } = shelfWithFact({ source: "test" });
    const ledger = buildPromotionLedger(shelf, { requireSource: true });

    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.decisions[0].state).toBe("promoted");
    expect(ledger.decisions[0].reasons).toEqual([]);
  });

  it("blocks promotion when source is required but missing", () => {
    const { shelf } = shelfWithFact();
    const ledger = buildPromotionLedger(shelf, { requireSource: true });

    expect(ledger.decisions[0].state).toBe("blocked");
    expect(ledger.decisions[0].reasons).toContain("missing_source");
  });

  it("blocks expired facts", () => {
    const { shelf } = shelfWithFact({ source: "test", expiresAt: "2000-01-01T00:00:00.000Z" });
    const ledger = buildPromotionLedger(shelf, { requireSource: true, now: new Date("2026-01-01T00:00:00.000Z") });

    expect(ledger.decisions[0].state).toBe("blocked");
    expect(ledger.decisions[0].reasons).toContain("expired");
  });

  it("blocks contradicted facts", () => {
    const { shelf, nugget } = shelfWithFact({ source: "test", value: "npm test" });
    nugget.remember("test-command", "vitest run", { source: "test" });
    nugget.recall("test-command", "session-4");
    const ledger = buildPromotionLedger(shelf, { requireSource: true });

    expect(ledger.decisions[0].state).toBe("blocked");
    expect(ledger.decisions[0].reasons).toContain("contradiction");
    expect(ledger.decisions[0].reasons).toContain("quarantined");
  });
});
