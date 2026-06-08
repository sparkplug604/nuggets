import { Nugget } from "../src/nuggets/memory.js";

interface BenchResult {
  dimension: number;
  banks: number;
  facts: number;
  accuracy: number;
  abstention_rate: number;
  wrong_decode_rate: number;
  avg_confidence: number;
  avg_margin: number;
  avg_entropy: number;
  capacity_pressure: number;
}

const dimensions = [1024, 2048, 4096, 8192];
const facts = [32, 64, 128, 180, 256, 360];
const banks = Number(process.env.NUGGETS_BENCH_BANKS || 4);

const results: BenchResult[] = [];

for (const D of dimensions) {
  for (const n of facts) {
    results.push(runCase(D, banks, n));
  }
}

console.log(JSON.stringify({ version: 1, results }, null, 2));

function runCase(D: number, bankCount: number, factCount: number): BenchResult {
  const nugget = new Nugget({
    name: `capacity-${D}-${bankCount}-${factCount}`,
    D,
    banks: bankCount,
    autoSave: false,
  });

  for (let i = 0; i < factCount; i++) {
    nugget.remember(`key-${i}`, `value-${i}`, { source: "capacity-benchmark" });
  }

  let correct = 0;
  let abstained = 0;
  let wrong = 0;
  let confidence = 0;
  let margin = 0;
  let entropy = 0;
  let capacityPressure = 0;

  for (let i = 0; i < factCount; i++) {
    const result = nugget.recall(`key-${i}`);
    if (result.abstained) abstained++;
    else if (result.answer === `value-${i}`) correct++;
    else wrong++;
    confidence += result.confidence;
    margin += result.margin;
    entropy += result.entropy;
    capacityPressure = result.capacity_pressure;
  }

  return {
    dimension: D,
    banks: bankCount,
    facts: factCount,
    accuracy: round(correct / factCount),
    abstention_rate: round(abstained / factCount),
    wrong_decode_rate: round(wrong / factCount),
    avg_confidence: round(confidence / factCount),
    avg_margin: round(margin / factCount),
    avg_entropy: round(entropy / factCount),
    capacity_pressure: capacityPressure,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
