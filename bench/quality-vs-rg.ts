#!/usr/bin/env npx tsx
/**
 * Quality comparison: FTS5 vs ripgrep for session recall
 *
 * Same test cases, both engines. Measures which finds the source turn
 * more often and ranks it higher.
 *
 * Note: rg only needs to find the right FILE (easier problem).
 * FTS5 must find the exact TURN. Yet FTS5 still wins.
 *
 * Run: npx tsx bench/quality-vs-rg.ts
 */

import { SessionIndex } from "../extensions/session-index.js";
import { execSync } from "child_process";
import { join } from "path";

const HOME = process.env.HOME!;
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const DB_PATH = "/tmp/pi-quality-vs-rg.db";

const idx = new SessionIndex(DB_PATH, SESSIONS_DIR);
await idx.reindex();
const stats = idx.stats();
console.log(`Index: ${stats.totalFiles} files, ${stats.totalTurns} turns\n`);

const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'this', 'that', 'these', 'those', 'it', 'its',
  'we', 'they', 'them', 'our', 'your', 'my', 'his', 'her', 'what', 'which',
  'who', 'when', 'where', 'how', 'why', 'if', 'then', 'else', 'for', 'from',
  'with', 'about', 'into', 'not', 'but', 'and', 'or', 'so', 'just', 'also',
  'too', 'very', 'really', 'all', 'any', 'some', 'no', 'yes', 'ok', 'sure',
  'let', 'me', 'you', 'to', 'of', 'in', 'on', 'at', 'by', 'up', 'out']);

function extractQuery(turnText: string): string | null {
  const lines = turnText.split('\n');
  const userLine = lines.find(l => l.startsWith('user:'));
  if (!userLine) return null;
  const text = userLine.replace(/^user:\s*/, '');
  if (text.length < 20 || text.length > 500) return null;

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  if (words.length < 2) return null;
  const picked: string[] = [];
  const step = Math.max(1, Math.floor(words.length / 4));
  for (let i = 0; i < words.length && picked.length < 4; i += step) {
    picked.push(words[i]);
  }
  return picked.length >= 2 ? picked.join(' ') : null;
}

// Sample and build test cases
const sampleRows = idx.db.prepare(`
  SELECT t.rowid, t.file_path, t.session_id, t.turn_index, t.byte_offset, t.byte_length
  FROM turn_offsets t ORDER BY RANDOM() LIMIT 200
`).all() as Array<{ rowid: number; file_path: string; session_id: string; turn_index: number; byte_offset: number; byte_length: number }>;

const testCases: Array<{ query: string; expectedSessionId: string; expectedTurnIndex: number; expectedFile: string }> = [];
for (const row of sampleRows) {
  if (testCases.length >= 50) break;
  const rawText = idx.readBytes(row.file_path, row.byte_offset, row.byte_length);
  const turnText = idx.parseTurnText(rawText);
  const query = extractQuery(turnText);
  if (query) {
    testCases.push({ query, expectedSessionId: row.session_id, expectedTurnIndex: row.turn_index, expectedFile: row.file_path });
  }
}

console.log(`Test cases: ${testCases.length}\n`);

// Run both
let ftsFound = 0, rgFound = 0, ftsRank1 = 0, rgRank1 = 0;
let ftsRRSum = 0, rgRRSum = 0;
let ftsOnlyWins = 0, rgOnlyWins = 0, bothFound = 0, bothMiss = 0;
let ftsTotalMs = 0, rgTotalMs = 0;

for (const tc of testCases) {
  // FTS5
  const t1 = Date.now();
  const ftsResults = idx.search(tc.query, { limit: 10, contextTurns: 0 });
  ftsTotalMs += Date.now() - t1;
  const ftsMatch = ftsResults.findIndex(r =>
    r.sessionId === tc.expectedSessionId && r.turnIndex === tc.expectedTurnIndex
  );
  const ftsRank = ftsMatch >= 0 ? ftsMatch + 1 : null;

  // ripgrep (find files containing ALL terms)
  const terms = tc.query.split(/\s+/);
  const t2 = Date.now();
  let rgFiles: string[] = [];
  try {
    let cmd = `rg -l -i "${terms[0]}" "${SESSIONS_DIR}" --glob "*.jsonl"`;
    for (let i = 1; i < terms.length; i++) {
      cmd += ` | xargs rg -l -i "${terms[i]}"`;
    }
    cmd += " 2>/dev/null | head -10";
    const out = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
    rgFiles = out ? out.split('\n') : [];
  } catch { rgFiles = []; }
  rgTotalMs += Date.now() - t2;
  const rgRank = rgFiles.indexOf(tc.expectedFile) >= 0 ? rgFiles.indexOf(tc.expectedFile) + 1 : null;

  // Tally
  if (ftsRank !== null) { ftsFound++; ftsRRSum += 1 / ftsRank; if (ftsRank === 1) ftsRank1++; }
  if (rgRank !== null) { rgFound++; rgRRSum += 1 / rgRank; if (rgRank === 1) rgRank1++; }
  if (ftsRank !== null && rgRank === null) ftsOnlyWins++;
  else if (ftsRank === null && rgRank !== null) rgOnlyWins++;
  else if (ftsRank !== null && rgRank !== null) bothFound++;
  else bothMiss++;
}

const n = testCases.length;
console.log("=== FTS5 vs ripgrep Quality ===\n");
console.log("Metric                | FTS5         | ripgrep");
console.log("----------------------|--------------|--------");
console.log(`Recall@10             | ${(ftsFound/n*100).toFixed(0)}% (${ftsFound}/${n})  | ${(rgFound/n*100).toFixed(0)}% (${rgFound}/${n})`);
console.log(`MRR                   | ${(ftsRRSum/n).toFixed(3)}        | ${(rgRRSum/n).toFixed(3)}`);
console.log(`Rank 1                | ${(ftsRank1/n*100).toFixed(0)}% (${ftsRank1}/${n})  | ${(rgRank1/n*100).toFixed(0)}% (${rgRank1}/${n})`);
console.log(`Avg latency           | ${(ftsTotalMs/n).toFixed(1)}ms       | ${(rgTotalMs/n).toFixed(1)}ms`);
console.log(`\nFTS5 only wins: ${ftsOnlyWins} | rg only wins: ${rgOnlyWins} | Both: ${bothFound} | Neither: ${bothMiss}`);
console.log(`\nNote: rg finds FILES, FTS5 finds exact TURNS (harder problem).`);

idx.close();
execSync(`rm -f ${DB_PATH}`);
