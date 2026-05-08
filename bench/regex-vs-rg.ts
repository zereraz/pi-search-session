#!/usr/bin/env npx tsx
/**
 * Regex benchmark: our searchRegex vs ripgrep
 *
 * Tests various regex patterns and compares:
 * - Speed (ms)
 * - Match count
 * - Granularity (turns vs files)
 *
 * Run: npm run bench:regex
 */

import { SessionIndex } from "../extensions/session-index.js";
import { execSync } from "child_process";
import { join } from "path";

const HOME = process.env.HOME!;
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const DB_PATH = "/tmp/pi-regex-bench.db";

execSync(`rm -f ${DB_PATH}`);
const idx = new SessionIndex(DB_PATH, SESSIONS_DIR);
await idx.reindex();
const stats = idx.stats();

console.log(`Index: ${stats.totalFiles} files, ${stats.totalTurns} turns\n`);

const PATTERNS = [
  { name: "package import", pattern: "@mariozechner/.*agent" },
  { name: "file path", pattern: "/Users/.*\\.ts" },
  { name: "error code", pattern: "ERR_[A-Z_]+" },
  { name: "URL", pattern: "https?://github\\.com/.*" },
  { name: "function call", pattern: "\\bexecSync\\b" },
  { name: "simple word", pattern: "sqlite" },
  { name: "import statement", pattern: "import.*from" },
  { name: "git SHA", pattern: "[0-9a-f]{7,40}" },
];

console.log("Pattern                  | ours (ms) | rg (ms) | ours hits | rg files | ratio");
console.log("-------------------------|-----------|---------|-----------|----------|------");

for (const { name, pattern } of PATTERNS) {
  // Our searchRegex (3 runs, best time)
  let bestOurs = Infinity;
  let oursHits = 0;
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const results = idx.searchRegex(pattern, { limit: 100 });
    const elapsed = Date.now() - t;
    if (elapsed < bestOurs) { bestOurs = elapsed; oursHits = results.length; }
  }

  // ripgrep (3 runs, best time)
  let bestRg = Infinity;
  let rgFiles = 0;
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    try {
      const out = execSync(
        `rg -l -i "${pattern}" "${SESSIONS_DIR}" --glob "*.jsonl" 2>/dev/null | wc -l`,
        { encoding: "utf-8", timeout: 5000 }
      );
      rgFiles = parseInt(out.trim()) || 0;
    } catch { rgFiles = 0; }
    bestRg = Math.min(bestRg, Date.now() - t);
  }

  const ratio = bestRg > 0 ? (bestOurs / bestRg).toFixed(1) + "x" : "N/A";
  console.log(
    `${name.padEnd(24)} | ${String(bestOurs).padStart(7)}ms | ${String(bestRg).padStart(5)}ms | ${String(oursHits).padStart(9)} | ${String(rgFiles).padStart(8)} | ${ratio}`
  );
}

console.log("\nNote: 'ours' returns turns (capped at limit=100), 'rg' returns files.");
console.log("Our scan reads first 2KB per turn. rg scans full file content.");

idx.close();
execSync(`rm -f ${DB_PATH}`);
