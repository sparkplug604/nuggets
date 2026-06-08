/**
 * NuggetShelf — multi-nugget manager.
 *
 * Organises multiple Nugget instances under a shared directory and
 * supports broadcast recall across all nuggets.
 */

import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Nugget, DEFAULT_SAVE_DIR } from "./memory.js";
import { DEFAULT_KIND_NAMES, type MemoryKind } from "./kinds.js";

const EMPTY_RECALL = {
  answer: null,
  confidence: 0,
  margin: 0,
  found: false,
  key: "",
  abstained: false,
  reason: "",
  raw_score: 0,
  entropy: 0,
  capacity_pressure: 0,
  top_k: [],
};

export class NuggetShelf {
  readonly saveDir: string;
  readonly autoSave: boolean;
  private _nuggets: Map<string, Nugget> = new Map();

  constructor(opts?: { saveDir?: string; autoSave?: boolean }) {
    this.saveDir = opts?.saveDir ?? DEFAULT_SAVE_DIR;
    this.autoSave = opts?.autoSave ?? true;
  }

  // -- nugget lifecycle ----------------------------------------------------

  create(
    name: string,
    opts?: { D?: number; banks?: number; ensembles?: number },
  ): Nugget {
    if (this._nuggets.has(name)) {
      throw new Error(`Nugget ${JSON.stringify(name)} already exists`);
    }
    const n = new Nugget({
      name,
      D: opts?.D ?? 16384,
      banks: opts?.banks ?? 4,
      ensembles: opts?.ensembles ?? 1,
      autoSave: this.autoSave,
      saveDir: this.saveDir,
    });
    this._nuggets.set(name, n);
    return n;
  }

  get(name: string): Nugget {
    const n = this._nuggets.get(name);
    if (!n) throw new Error(`Nugget ${JSON.stringify(name)} not found`);
    return n;
  }

  getOrCreate(name: string): Nugget {
    if (this._nuggets.has(name)) return this._nuggets.get(name)!;
    return this.create(name);
  }

  remove(name: string): void {
    if (!this._nuggets.has(name)) {
      throw new Error(`Nugget ${JSON.stringify(name)} not found`);
    }
    const path = join(this.saveDir, `${name}.nugget.json`);
    if (existsSync(path)) unlinkSync(path);
    this._nuggets.delete(name);
  }

  list(): Array<ReturnType<Nugget["status"]>> {
    return [...this._nuggets.values()].map((n) => n.status());
  }

  kindName(kind: MemoryKind): string {
    return DEFAULT_KIND_NAMES[kind];
  }

  getOrCreateKind(kind: MemoryKind): Nugget {
    return this.getOrCreate(this.kindName(kind));
  }

  // -- convenience pass-throughs -------------------------------------------

  remember(nuggetName: string, key: string, value: string): void {
    this.get(nuggetName).remember(key, value);
  }

  rememberKind(kind: MemoryKind, key: string, value: string): void {
    this.getOrCreateKind(kind).remember(key, value);
  }

  recall(
    query: string,
    nuggetName?: string,
    sessionId = "",
  ): ReturnType<Nugget["recall"]> & { nugget_name: string | null } {
    if (nuggetName) {
      const result = this.get(nuggetName).recall(query, sessionId);
      return { ...result, nugget_name: nuggetName };
    }

    let best: ReturnType<Nugget["recall"]> & { nugget_name: string | null } = {
      ...EMPTY_RECALL,
      nugget_name: null,
    };

    for (const [name, nugget] of this._nuggets) {
      const result = nugget.recall(query, sessionId);
      if (result.found && result.confidence > best.confidence) {
        best = { ...result, nugget_name: name };
      }
    }
    return best;
  }

  recallInOrder(
    query: string,
    nuggetNames: string[],
    sessionId = "",
  ): ReturnType<Nugget["recall"]> & { nugget_name: string | null } {
    let best: ReturnType<Nugget["recall"]> & { nugget_name: string | null } = {
      ...EMPTY_RECALL,
      nugget_name: null,
    };

    for (const name of nuggetNames) {
      if (!this.has(name)) continue;
      const result = this.get(name).recall(query, sessionId);
      if (!result.found) continue;
      if (!best.found || result.confidence > best.confidence) {
        best = { ...result, nugget_name: name };
      }
    }

    return best;
  }

  recallByKind(
    query: string,
    kinds: MemoryKind[] = ["user", "project", "agent"],
    sessionId = "",
  ): ReturnType<Nugget["recall"]> & { nugget_name: string | null; memory_kind: MemoryKind | null } {
    const orderedNames = kinds.map((kind) => this.kindName(kind));
    const result = this.recallInOrder(query, orderedNames, sessionId);
    const memoryKind = kinds.find((kind) => this.kindName(kind) === result.nugget_name) ?? null;
    return { ...result, memory_kind: memoryKind };
  }

  forget(nuggetName: string, key: string): boolean {
    return this.get(nuggetName).forget(key);
  }

  forgetKind(kind: MemoryKind, key: string): boolean {
    if (!this.has(this.kindName(kind))) return false;
    return this.get(this.kindName(kind)).forget(key);
  }

  // -- persistence ---------------------------------------------------------

  loadAll(): void {
    if (!existsSync(this.saveDir)) return;
    for (const fname of readdirSync(this.saveDir)) {
      if (!fname.endsWith(".nugget.json")) continue;
      const path = join(this.saveDir, fname);
      try {
        const n = Nugget.load(path, { autoSave: this.autoSave });
        this._nuggets.set(n.name, n);
      } catch {
        // skip corrupt files
      }
    }
  }

  saveAll(): void {
    for (const n of this._nuggets.values()) {
      n.save();
    }
  }

  has(name: string): boolean {
    return this._nuggets.has(name);
  }

  get size(): number {
    return this._nuggets.size;
  }
}
