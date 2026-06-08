/**
 * Nugget — a single holographic memory unit.
 *
 * Stores key-value facts as superposed complex-valued vectors and retrieves
 * them via algebraic unbinding. Deterministic rebuild from facts using
 * seeded RNG so vectors are never serialised.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type ComplexVector,
  seedFromName,
  mulberry32,
  makeVocabKeys,
  makeRoleKeys,
  orthogonalize,
  stackAndUnitNorm,
  bind,
  unbind,
  sharpen,
  corvacsLite,
  softmaxTemp,
} from "./core.js";

export const DEFAULT_SAVE_DIR = join(homedir(), ".nuggets");

export type PromotionState = "candidate" | "promoted" | "blocked" | "quarantined";

export interface Fact {
  key: string;
  value: string;
  hits: number;
  last_hit_session: string;
  created_at: string;
  updated_at: string;
  source?: string;
  expires_at?: string;
  previous_values?: string[];
  contradiction_group?: string;
  confidence?: number;
  last_recall_confidence?: number;
  last_recall_margin?: number;
  promotion_state?: PromotionState;
}

export interface RememberOptions {
  source?: string;
  expiresAt?: string;
  confidence?: number;
  promotionState?: PromotionState;
}

export interface RecallCandidate {
  answer: string;
  raw_score: number;
  probability: number;
}

export interface RecallOptions {
  topK?: number;
  minConfidence?: number;
  minMargin?: number;
  abstainOnUncertainty?: boolean;
}

export interface RecallResult {
  answer: string | null;
  confidence: number;
  margin: number;
  found: boolean;
  key: string;
  abstained: boolean;
  reason: string;
  raw_score: number;
  entropy: number;
  capacity_pressure: number;
  top_k: RecallCandidate[];
}

interface BankData {
  memory: ComplexVector;
  vocabKeys: ComplexVector[];
  vocabNorm: Float64Array[];
  sentKeys: ComplexVector[];
  roleKeys: ComplexVector[];
}

interface EnsembleData {
  banks: BankData[];
}

interface NuggetFile {
  version: number;
  name: string;
  D: number;
  banks: number;
  ensembles: number;
  max_facts: number;
  facts: Fact[];
  config: {
    sharpen_p: number;
    corvacs_a: number;
    temp_T: number;
    orth_iters: number;
  };
}

export class Nugget {
  readonly name: string;
  readonly D: number;
  readonly banks: number;
  readonly ensembles: number;
  autoSave: boolean;
  saveDir: string;
  maxFacts: number;

  // Hyperparameters
  private _sharpenP = 1.0;
  private _corvacsA = 0.0;
  private _tempT = 0.9;
  private _orthIters = 1;
  private _orthStep = 0.4;
  private _fuzzyThreshold = 0.55;
  private _defaultMinConfidence = 0.12;
  private _defaultMinMargin = 0.001;

  private _facts: Fact[] = [];
  private _E: EnsembleData[] | null = null;
  private _vocabWords: string[] = [];
  private _tagToPos: Map<string, number> = new Map();
  private _dirty = false;

  constructor(opts: {
    name: string;
    D?: number;
    banks?: number;
    ensembles?: number;
    autoSave?: boolean;
    saveDir?: string;
    maxFacts?: number;
  }) {
    this.name = opts.name;
    this.D = opts.D ?? 16384;
    this.banks = opts.banks ?? 4;
    this.ensembles = opts.ensembles ?? 1;
    this.autoSave = opts.autoSave ?? true;
    this.saveDir = opts.saveDir ?? DEFAULT_SAVE_DIR;
    this.maxFacts = opts.maxFacts ?? 0;
  }

  // -- public API ----------------------------------------------------------

  remember(key: string, value: string, opts: RememberOptions = {}): void {
    key = key.trim();
    value = value.trim();
    if (!key || !value) return;

    const now = new Date().toISOString();

    let found = false;
    for (const f of this._facts) {
      if (f.key.toLowerCase() === key.toLowerCase()) {
        if (f.value !== value) {
          f.previous_values = [...new Set([...(f.previous_values || []), f.value])];
          f.contradiction_group = f.contradiction_group || `key:${key.toLowerCase()}`;
          f.promotion_state = "quarantined";
        }
        f.value = value;
        f.updated_at = now;
        f.source = opts.source ?? f.source;
        f.expires_at = opts.expiresAt ?? f.expires_at;
        f.confidence = opts.confidence ?? f.confidence;
        f.promotion_state = opts.promotionState ?? f.promotion_state;
        found = true;
        break;
      }
    }
    if (!found) {
      this._facts.push({
        key,
        value,
        hits: 0,
        last_hit_session: "",
        created_at: now,
        updated_at: now,
        source: opts.source,
        expires_at: opts.expiresAt,
        confidence: opts.confidence,
        promotion_state: opts.promotionState ?? "candidate",
      });
    }

    // Evict oldest facts if max_facts exceeded
    if (this.maxFacts > 0 && this._facts.length > this.maxFacts) {
      this._facts = this._facts.slice(-this.maxFacts);
    }

    this._dirty = true;
    if (this.autoSave) this.save();
  }

  recall(
    query: string,
    sessionId = "",
    opts: RecallOptions = {},
  ): RecallResult {
    const empty = {
      answer: null,
      confidence: 0,
      margin: 0,
      found: false,
      key: "",
      abstained: false,
      reason: "",
      raw_score: 0,
      entropy: 0,
      capacity_pressure: this._capacityPressure(),
      top_k: [],
    };
    if (this._facts.length === 0) return empty;

    if (this._dirty || this._E === null) {
      this._rebuild();
      this._dirty = false;
    }

    const tag = this._resolveTag(query);
    if (!tag || !this._tagToPos.has(tag)) return empty;

    const { word, sims, probs } = this._decode(tag);
    const topK = rankCandidates(this._vocabWords, sims, probs, opts.topK ?? 3);

    // Top-2 for confidence/margin
    let top1 = -Infinity;
    let top2 = -Infinity;
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > top1) {
        top2 = top1;
        top1 = probs[i];
      } else if (probs[i] > top2) {
        top2 = probs[i];
      }
    }
    const probabilityMargin = top2 === -Infinity ? top1 : top1 - top2;
    const rawScore = topK[0]?.raw_score ?? 0;
    const rawMargin = topK.length > 1 ? rawScore - topK[1].raw_score : Math.max(rawScore, 0);
    const capacityPressure = this._capacityPressure();
    const entropy = normalizedEntropy(probs);
    const confidence = calibratedConfidence(rawScore, rawMargin, entropy, capacityPressure);
    const minConfidence = opts.minConfidence ?? this._defaultMinConfidence;
    const minMargin = opts.minMargin ?? this._defaultMinMargin;
    const abstainOnUncertainty = opts.abstainOnUncertainty ?? true;
    const reason = recallAbstentionReason({
      confidence,
      margin: rawMargin,
      entropy,
      capacityPressure,
      minConfidence,
      minMargin,
    });
    const abstained = abstainOnUncertainty && reason !== "";

    // Hit tracking (per-session dedup)
    if (sessionId) {
      const pos = this._tagToPos.get(tag)!;
      const fact = this._facts[pos];
      if (fact.last_hit_session !== sessionId) {
        fact.hits = (fact.hits || 0) + 1;
        fact.last_hit_session = sessionId;
        fact.last_recall_confidence = confidence;
        fact.last_recall_margin = rawMargin;
        if (this.autoSave) this.save();
      }
    }

    return {
      answer: abstained ? null : word,
      confidence,
      margin: rawMargin || probabilityMargin,
      found: !abstained,
      key: tag,
      abstained,
      reason,
      raw_score: rawScore,
      entropy,
      capacity_pressure: capacityPressure,
      top_k: topK,
    };
  }

  forget(key: string): boolean {
    const lower = key.toLowerCase().trim();
    const before = this._facts.length;
    this._facts = this._facts.filter((f) => f.key.toLowerCase() !== lower);
    const removed = this._facts.length < before;
    if (removed) {
      this._dirty = true;
      if (this.autoSave) this.save();
    }
    return removed;
  }

  facts(): Fact[] {
    return this._facts.map((f) => ({ ...f, previous_values: f.previous_values ? [...f.previous_values] : undefined }));
  }

  clear(): void {
    this._facts = [];
    this._E = null;
    this._vocabWords = [];
    this._tagToPos = new Map();
    this._dirty = false;
    if (this.autoSave) this.save();
  }

  status(): {
    name: string;
    fact_count: number;
    dimension: number;
    banks: number;
    ensembles: number;
    capacity_used_pct: number;
    capacity_warning: string;
    capacity_estimate: number;
    capacity_pressure: number;
    max_facts: number;
  } {
    const capacityEst = this._capacityEstimate();
    const usedPct = capacityEst > 0 ? (this._facts.length / capacityEst) * 100 : 0;
    let capacityWarning = "";
    if (usedPct > 90) capacityWarning = "CRITICAL: nearly full";
    else if (usedPct > 80) capacityWarning = "WARNING: approaching capacity";

    return {
      name: this.name,
      fact_count: this._facts.length,
      dimension: this.D,
      banks: this.banks,
      ensembles: this.ensembles,
      capacity_used_pct: Math.round(usedPct * 10) / 10,
      capacity_warning: capacityWarning,
      capacity_estimate: capacityEst,
      capacity_pressure: this._capacityPressure(),
      max_facts: this.maxFacts,
    };
  }

  // -- persistence ---------------------------------------------------------

  save(path?: string): string {
    if (!path) {
      mkdirSync(this.saveDir, { recursive: true });
      path = join(this.saveDir, `${this.name}.nugget.json`);
    }

    const data: NuggetFile = {
      version: 3,
      name: this.name,
      D: this.D,
      banks: this.banks,
      ensembles: this.ensembles,
      max_facts: this.maxFacts,
      facts: this._facts,
      config: {
        sharpen_p: this._sharpenP,
        corvacs_a: this._corvacsA,
        temp_T: this._tempT,
        orth_iters: this._orthIters,
      },
    };

    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data));
    renameSync(tmpPath, path);
    return path;
  }

  static load(path: string, opts?: { autoSave?: boolean }): Nugget {
    const raw = readFileSync(path, "utf-8");
    const data: NuggetFile = JSON.parse(raw);

    const n = new Nugget({
      name: data.name,
      D: data.D,
      banks: data.banks,
      ensembles: data.ensembles ?? 1,
      autoSave: opts?.autoSave ?? true,
      saveDir: join(path, ".."),
      maxFacts: data.max_facts ?? 0,
    });

    const cfg = data.config || ({} as Partial<NuggetFile["config"]>);
    n._sharpenP = cfg.sharpen_p ?? n._sharpenP;
    n._corvacsA = cfg.corvacs_a ?? n._corvacsA;
    n._tempT = cfg.temp_T ?? n._tempT;
    n._orthIters = cfg.orth_iters ?? n._orthIters;

    n._facts = (data.facts || []).map((f) => ({
      key: f.key,
      value: f.value,
      hits: f.hits ?? 0,
      last_hit_session: f.last_hit_session ?? "",
      created_at: f.created_at ?? new Date(0).toISOString(),
      updated_at: f.updated_at ?? new Date(0).toISOString(),
      source: f.source,
      expires_at: f.expires_at,
      previous_values: f.previous_values,
      contradiction_group: f.contradiction_group,
      confidence: f.confidence,
      last_recall_confidence: f.last_recall_confidence,
      last_recall_margin: f.last_recall_margin,
      promotion_state: f.promotion_state,
    }));

    if (n._facts.length > 0) {
      n._rebuild();
    }
    return n;
  }

  // -- internals -----------------------------------------------------------

  private _rebuild(): void {
    if (this._facts.length === 0) {
      this._E = null;
      this._vocabWords = [];
      this._tagToPos = new Map();
      return;
    }

    // Build vocabulary from unique values
    const seen = new Set<string>();
    const vocab: string[] = [];
    for (const f of this._facts) {
      if (!seen.has(f.value)) {
        vocab.push(f.value);
        seen.add(f.value);
      }
    }
    this._vocabWords = vocab;

    // Tag → position mapping
    this._tagToPos = new Map();
    for (let i = 0; i < this._facts.length; i++) {
      this._tagToPos.set(this._facts[i].key, i);
    }
    const L = this._facts.length;

    // Deterministic seed from name
    const seed = seedFromName(this.name);
    const rng = mulberry32(seed);

    const V = vocab.length;
    const idxW = new Map<string, number>();
    for (let i = 0; i < V; i++) idxW.set(vocab[i], i);

    // Round-robin bank assignment
    const itemsByBank: Array<Array<{ sid: number; pos: number; word: string }>> = [];
    for (let b = 0; b < this.banks; b++) itemsByBank.push([]);
    for (let i = 0; i < this._facts.length; i++) {
      itemsByBank[i % this.banks].push({
        sid: 0,
        pos: i,
        word: this._facts[i].value,
      });
    }

    const E: EnsembleData[] = [];
    for (let e = 0; e < this.ensembles; e++) {
      let vocabKeys = makeVocabKeys(V, this.D, rng);
      if (this._orthIters > 0) {
        vocabKeys = orthogonalize(vocabKeys, this._orthIters, this._orthStep);
      }
      const vocabNorm = stackAndUnitNorm(vocabKeys);

      const sentKeys = makeVocabKeys(1, this.D, rng); // single sentence
      const roleKeys = makeRoleKeys(this.D, L);

      const banks: BankData[] = [];
      for (let b = 0; b < this.banks; b++) {
        const items = itemsByBank[b];
        const bindings: ComplexVector[] = [];

        for (const { sid, pos, word } of items) {
          const sKey = sentKeys[sid];
          const rKey = roleKeys[pos];
          const wKey = vocabKeys[idxW.get(word)!];
          bindings.push(bind(bind(sKey, rKey), wKey));
        }

        let memory: ComplexVector;
        if (bindings.length > 0) {
          // Sum bindings
          const re = new Float64Array(this.D);
          const im = new Float64Array(this.D);
          for (const b of bindings) {
            for (let d = 0; d < this.D; d++) {
              re[d] += b.re[d];
              im[d] += b.im[d];
            }
          }
          // Scale by 1/sqrt(n)
          const scale = 1.0 / Math.sqrt(bindings.length);
          for (let d = 0; d < this.D; d++) {
            re[d] *= scale;
            im[d] *= scale;
          }
          memory = { re, im };
        } else {
          memory = {
            re: new Float64Array(this.D),
            im: new Float64Array(this.D),
          };
        }

        banks.push({ memory, vocabKeys, vocabNorm, sentKeys, roleKeys });
      }
      E.push({ banks });
    }
    this._E = E;
  }

  private _decode(tag: string): { word: string; sims: Float64Array; probs: Float64Array } {
    const pos = this._tagToPos.get(tag)!;
    const sid = 0;
    const V = this._vocabWords.length;
    const simsSum = new Float64Array(V);

    for (const ens of this._E!) {
      for (const bank of ens.banks) {
        // Unbind sentence, then role
        let rec = unbind(unbind(bank.memory, bank.sentKeys[sid]), bank.roleKeys[pos]);
        rec = corvacsLite(sharpen(rec, this._sharpenP), this._corvacsA);

        // Convert to 2D real + unit norm
        const D = this.D;
        const rec2 = new Float64Array(D * 2);
        rec2.set(rec.re, 0);
        rec2.set(rec.im, D);
        let norm = 0;
        for (let d = 0; d < D * 2; d++) norm += rec2[d] * rec2[d];
        norm = 1 / (Math.sqrt(norm) + 1e-12);
        for (let d = 0; d < D * 2; d++) rec2[d] *= norm;

        // Cosine sim: vocab_norm @ rec2
        for (let v = 0; v < V; v++) {
          const row = bank.vocabNorm[v];
          let dot = 0;
          for (let d = 0; d < D * 2; d++) dot += row[d] * rec2[d];
          simsSum[v] += dot;
        }
      }
    }

    const probs = softmaxTemp(simsSum, this._tempT);
    let bestIdx = 0;
    for (let i = 1; i < V; i++) {
      if (probs[i] > probs[bestIdx]) bestIdx = i;
    }

    return { word: this._vocabWords[bestIdx], sims: simsSum, probs };
  }

  private _capacityEstimate(): number {
    return this.banks * Math.floor(Math.sqrt(this.D));
  }

  private _capacityPressure(): number {
    const capacityEst = this._capacityEstimate();
    if (capacityEst <= 0) return 1;
    return Math.round((this._facts.length / capacityEst) * 1000) / 1000;
  }

  /** Fuzzy-match query to stored keys (threshold >= 0.55). */
  private _resolveTag(query: string): string {
    if (this._tagToPos.size === 0) return "";
    const text = query.toLowerCase().trim();
    const tags = [...this._tagToPos.keys()];

    // Exact match
    for (const t of tags) {
      if (t.toLowerCase() === text) return t;
    }

    // Substring match
    for (const t of tags) {
      if (t.toLowerCase().includes(text) || text.includes(t.toLowerCase())) return t;
    }

    // Token overlap fallback — helps natural language queries like
    // "how to deploy" → "deploy-process"
    const queryTokens = tokenizeForMatch(text);
    let bestTokenTag = "";
    let bestTokenScore = 0;
    if (queryTokens.size > 0) {
      for (const t of tags) {
        const tagTokens = tokenizeForMatch(t.toLowerCase());
        const score = tokenOverlapScore(queryTokens, tagTokens);
        if (score > bestTokenScore) {
          bestTokenTag = t;
          bestTokenScore = score;
        }
      }
    }
    if (bestTokenScore >= 0.5) return bestTokenTag;

    // Fuzzy match (SequenceMatcher equivalent)
    let best = "";
    let bestScore = 0;
    for (const t of tags) {
      const s = sequenceMatchRatio(text, t.toLowerCase());
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    return bestScore >= this._fuzzyThreshold ? best : "";
  }
}

// ---------------------------------------------------------------------------
// Fuzzy matching — port of Python's SequenceMatcher.ratio()
// ---------------------------------------------------------------------------

function sequenceMatchRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matches = countMatches(a, b);
  return (2 * matches) / (a.length + b.length);
}

const MATCH_STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "its", "this", "that", "these", "those",
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "and", "or", "but", "nor", "not", "no", "so", "if", "then",
  "of", "in", "on", "at", "to", "for", "with", "by", "from",
  "up", "about", "into", "through", "during", "before", "after",
  "again", "further", "just", "also", "very", "too", "only",
  "all", "any", "both", "each", "few", "more", "most", "some",
  "such", "than", "other", "own", "same", "here", "there", "now",
  "then", "once", "show", "tell", "run", "use", "using",
]);

function tokenizeForMatch(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const tokens = new Set<string>();
  for (const word of cleaned.split(/\s+/)) {
    if (!word || word.length < 2) continue;
    if (MATCH_STOP_WORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

function tokenOverlapScore(queryTokens: Set<string>, tagTokens: Set<string>): number {
  if (queryTokens.size === 0 || tagTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (tagTokens.has(token)) overlap++;
  }
  return overlap / Math.max(1, Math.min(queryTokens.size, tagTokens.size));
}

function rankCandidates(
  words: string[],
  sims: Float64Array,
  probs: Float64Array,
  topK: number,
): RecallCandidate[] {
  const indexes = [...words.keys()];
  indexes.sort((a, b) => sims[b] - sims[a]);
  return indexes.slice(0, Math.max(1, topK)).map((idx) => ({
    answer: words[idx],
    raw_score: roundMetric(sims[idx]),
    probability: roundMetric(probs[idx]),
  }));
}

function normalizedEntropy(probs: Float64Array): number {
  if (probs.length <= 1) return 0;
  let entropy = 0;
  for (const p of probs) {
    if (p > 0) entropy -= p * Math.log(p);
  }
  return roundMetric(entropy / Math.log(probs.length));
}

function calibratedConfidence(
  rawScore: number,
  rawMargin: number,
  entropy: number,
  capacityPressure: number,
): number {
  const scoreComponent = clamp((rawScore + 0.1) / 0.35, 0, 1);
  const marginComponent = clamp(rawMargin / 0.08, 0, 1);
  const entropyComponent = clamp(1 - entropy, 0, 1);
  const capacityComponent = clamp(1 - Math.max(0, capacityPressure - 0.8) / 0.7, 0, 1);
  return roundMetric(
    0.4 * scoreComponent +
    0.35 * marginComponent +
    0.15 * entropyComponent +
    0.1 * capacityComponent,
  );
}

function recallAbstentionReason(args: {
  confidence: number;
  margin: number;
  entropy: number;
  capacityPressure: number;
  minConfidence: number;
  minMargin: number;
}): string {
  if (args.capacityPressure >= 1.25 && args.entropy > 0.99) {
    return "capacity_pressure";
  }
  if (args.capacityPressure >= 1.25 && args.margin < args.minMargin * 4) {
    return "capacity_pressure";
  }
  if (args.confidence < args.minConfidence) return "low_confidence";
  if (args.margin < args.minMargin) return "low_margin";
  if (args.entropy > 0.995 && args.margin < args.minMargin * 2) return "high_entropy";
  return "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Count matching characters using longest common subsequence blocks. */
function countMatches(a: string, b: string): number {
  // Simple LCS-based matching (approximates SequenceMatcher)
  const m = a.length;
  const n = b.length;

  // Find all matching blocks
  let total = 0;
  const usedA = new Set<number>();
  const usedB = new Set<number>();

  // Greedy longest common substring, iteratively
  while (true) {
    let bestLen = 0;
    let bestI = 0;
    let bestJ = 0;

    for (let i = 0; i < m; i++) {
      if (usedA.has(i)) continue;
      for (let j = 0; j < n; j++) {
        if (usedB.has(j)) continue;
        let len = 0;
        while (
          i + len < m &&
          j + len < n &&
          !usedA.has(i + len) &&
          !usedB.has(j + len) &&
          a[i + len] === b[j + len]
        ) {
          len++;
        }
        if (len > bestLen) {
          bestLen = len;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestLen === 0) break;

    for (let k = 0; k < bestLen; k++) {
      usedA.add(bestI + k);
      usedB.add(bestJ + k);
    }
    total += bestLen;
  }

  return total;
}
