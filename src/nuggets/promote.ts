/**
 * MEMORY.md promotion — bridge nuggets to Claude Code's native memory.
 *
 * Facts recalled 3+ times across sessions are promoted to MEMORY.md
 * for permanent context inclusion.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { NuggetShelf } from "./shelf.js";
import type { Fact } from "./memory.js";

const PROMOTE_THRESHOLD = 3;
const LEDGER_FILE = "nuggets-promotion-ledger.json";

const MEMORY_MD_HEADER = `# Memory

Auto-promoted from nuggets (3+ recalls across sessions).
`;

function detectMemoryDir(): string | null {
  const cwd = process.cwd();
  // Claude Code convention: replace / with - and prepend -
  const safe = cwd.replace(/\//g, "-");
  const memoryDir = join(homedir(), ".claude", "projects", safe, "memory");
  const projectDir = dirname(memoryDir);
  if (!existsSync(projectDir)) return null;
  return memoryDir;
}

interface Sections {
  [section: string]: { [key: string]: string };
}

export interface PromotionPolicy {
  minHits?: number;
  minConfidence?: number;
  minMargin?: number;
  requireSource?: boolean;
  now?: Date;
}

export type PromotionDecisionState = "promoted" | "blocked";

export interface PromotionDecision {
  id: string;
  nugget_name: string;
  key: string;
  value: string;
  state: PromotionDecisionState;
  reasons: string[];
  hits: number;
  confidence: number | null;
  margin: number | null;
  source: string | null;
  contradiction_group: string | null;
  expires_at: string | null;
  checked_at: string;
}

export interface PromotionLedger {
  version: number;
  generated_at: string;
  decisions: PromotionDecision[];
}

function parseMemoryMd(content: string): Sections {
  const sections: Sections = {};
  let currentSection = "";

  for (const line of content.split("\n")) {
    const stripped = line.trim();

    // Section header
    const sectionMatch = stripped.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!(currentSection in sections)) {
        sections[currentSection] = {};
      }
      continue;
    }

    // Fact entry: - **key**: value
    const factMatch = stripped.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (factMatch && currentSection) {
      sections[currentSection][factMatch[1].trim()] = factMatch[2].trim();
    }
  }

  return sections;
}

function renderMemoryMd(sections: Sections): string {
  const keys = Object.keys(sections);
  if (keys.length === 0) return MEMORY_MD_HEADER;

  // Ordering: learnings first, preferences second, then alphabetical
  const priority = ["learnings", "preferences"];
  const ordered: string[] = [];
  for (const p of priority) {
    if (p in sections) ordered.push(p);
  }
  const remaining = keys.filter((k) => !priority.includes(k)).sort();
  ordered.push(...remaining);

  const lines = [MEMORY_MD_HEADER];
  for (const sectionName of ordered) {
    const facts = sections[sectionName];
    const entries = Object.entries(facts);
    if (entries.length === 0) continue;
    lines.push(`## ${sectionName}\n`);
    for (const [key, value] of entries) {
      lines.push(`- **${key}**: ${value}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Promote facts with hits >= threshold to MEMORY.md.
 * Merges into existing MEMORY.md (idempotent). Returns count of
 * newly promoted facts.
 */
export function promoteFacts(shelf: NuggetShelf): number {
  const memoryDir = detectMemoryDir();
  if (!memoryDir) return 0;

  const ledger = buildPromotionLedger(shelf);
  writePromotionLedger(memoryDir, ledger);
  const candidates = ledger.decisions.filter((decision) => decision.state === "promoted");

  if (candidates.length === 0) return 0;

  // Load existing MEMORY.md
  const memoryPath = join(memoryDir, "MEMORY.md");
  let existingContent = "";
  if (existsSync(memoryPath)) {
    existingContent = readFileSync(memoryPath, "utf-8");
  }

  const sections = existingContent ? parseMemoryMd(existingContent) : {};

  // Merge candidates
  let newCount = 0;
  for (const { nugget_name, key, value } of candidates) {
    if (!(nugget_name in sections)) {
      sections[nugget_name] = {};
    }
    const existing = sections[nugget_name][key];
    if (existing !== value) {
      sections[nugget_name][key] = value;
      if (existing === undefined) newCount++;
    }
  }

  if (newCount === 0 && existingContent) {
    const newContent = renderMemoryMd(sections);
    if (newContent === existingContent) return 0;
  }

  // Atomic write
  mkdirSync(memoryDir, { recursive: true });
  const tmpPath = memoryPath + ".tmp";
  const newContent = renderMemoryMd(sections);
  writeFileSync(tmpPath, newContent);
  renameSync(tmpPath, memoryPath);

  return newCount;
}

export function buildPromotionLedger(
  shelf: NuggetShelf,
  policy: PromotionPolicy = {},
): PromotionLedger {
  const now = policy.now ?? new Date();
  const minHits = policy.minHits ?? PROMOTE_THRESHOLD;
  const minConfidence = policy.minConfidence ?? 0.2;
  const minMargin = policy.minMargin ?? 0.001;
  const requireSource = policy.requireSource ?? false;
  const decisions: PromotionDecision[] = [];

  for (const info of shelf.list()) {
    const nuggetName = info.name;
    try {
      const nugget = shelf.get(nuggetName);
      for (const fact of nugget.facts()) {
        decisions.push(decidePromotion(nuggetName, fact, {
          now,
          minHits,
          minConfidence,
          minMargin,
          requireSource,
        }));
      }
    } catch {
      continue;
    }
  }

  return {
    version: 1,
    generated_at: now.toISOString(),
    decisions,
  };
}

function decidePromotion(
  nuggetName: string,
  fact: Fact,
  policy: Required<Pick<PromotionPolicy, "minHits" | "minConfidence" | "minMargin" | "requireSource">> & { now: Date },
): PromotionDecision {
  const reasons: string[] = [];
  const hits = fact.hits || 0;
  const confidence = fact.last_recall_confidence ?? fact.confidence ?? null;
  const margin = fact.last_recall_margin ?? null;

  if (hits < policy.minHits) reasons.push("insufficient_hits");
  if (confidence === null || confidence < policy.minConfidence) reasons.push("low_confidence");
  if (margin === null || margin < policy.minMargin) reasons.push("low_margin");
  if (fact.contradiction_group) reasons.push("contradiction");
  if (fact.promotion_state === "quarantined") reasons.push("quarantined");
  if (policy.requireSource && !fact.source) reasons.push("missing_source");
  if (fact.expires_at && Date.parse(fact.expires_at) <= policy.now.getTime()) reasons.push("expired");

  return {
    id: `${nuggetName}:${fact.key}`,
    nugget_name: nuggetName,
    key: fact.key,
    value: fact.value,
    state: reasons.length === 0 ? "promoted" : "blocked",
    reasons,
    hits,
    confidence,
    margin,
    source: fact.source ?? null,
    contradiction_group: fact.contradiction_group ?? null,
    expires_at: fact.expires_at ?? null,
    checked_at: policy.now.toISOString(),
  };
}

function writePromotionLedger(memoryDir: string, ledger: PromotionLedger): void {
  mkdirSync(memoryDir, { recursive: true });
  const ledgerPath = join(memoryDir, LEDGER_FILE);
  const tmpPath = ledgerPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmpPath, ledgerPath);
}
