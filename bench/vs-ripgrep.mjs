#!/usr/bin/env node
/**
 * Benchmark: FTS5 session search vs ripgrep
 *
 * Compares search quality and speed between:
 * - pi-session-search (FTS5 + BM25 at turn granularity)
 * - ripgrep (raw text search across JSONL files)
 *
 * Run: node bench/vs-ripgrep.mjs
 */

import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { join } from "path";

const jiti = createJiti(fileURLToPath(import.meta.url));
const { SessionIndex } = jiti(join(fileURLToPath(import.meta.url), "../../extensions/session-index.ts"));

const HOME = process.env.HOME;
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const DB_PATH = "/tmp/pi-bench-vs-rg.db";

// Test queries — mix of specific and broad
const QUERIES = [
  "sqlite FTS5 session index",
  "vllm prefix caching",
  "extension memory",
  "git commit rebase",
  "typescript import error",
];

console.log("=== pi-session-search vs ripgrep benchmark ===\n");
console.log(`Sessions dir: ${SESSIONS_DIR}`);

// Build index
const idx = new SessionIndex(DB_PATH, SESSIONS_DIR);
const t0 = Date.now();
await idx.reindex();
console.log(`Index built: ${Date.now() - t0}ms\n`);

console.log("Query                          | FTS5 hits | rg files | FTS5 ms | rg ms");
console.log("-------------------------------|-----------|----------|---------|------");

for (const query of QUERIES) {
  // FTS5 search
  const t1 = Date.now();
  const ftsResults = idx.search(query, { limit: 20, contextTurns: 0 });
  const ftsMs = Date.now() - t1;

  // ripgrep search (search all JSONL files for all terms)
  const terms = query.split(/\s+/);
  const rgPattern = terms.join(".*");
  const t2 = Date.now();
  let rgFiles = 0;
  try {
    const rgOut = execSync(
      `rg -l -i "${rgPattern}" "${SESSIONS_DIR}" --glob "*.jsonl" 2>/dev/null | wc -l`,
      { encoding: "utf-8", timeout: 10000 }
    );
    rgFiles = parseInt(rgOut.trim()) || 0;
  } catch { rgFiles = 0; }
  const rgMs = Date.now() - t2;

  const label = query.padEnd(30);
  console.log(`${label} | ${String(ftsResults.length).padStart(9)} | ${String(rgFiles).padStart(8)} | ${String(ftsMs).padStart(7)} | ${String(rgMs).padStart(5)}`);
}

console.log("\n--- Analysis ---");
console.log("FTS5 returns TURNS (ranked by BM25). All query terms must co-occur in the same turn.");
console.log("rg returns FILES that contain the pattern anywhere (terms may be in unrelated turns).");
console.log("FTS5 is precise (fewer false positives). rg is broad (more results, but noisy).");

idx.close();

// Cleanup
execSync(`rm -f ${DB_PATH}`);
