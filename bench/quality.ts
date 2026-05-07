#!/usr/bin/env npx tsx
/**
 * Quality benchmark: Precision & Recall for session search
 *
 * Method:
 * 1. Sample N real turns from the index (ground truth documents)
 * 2. For each turn, extract a query (distinctive keywords from user message)
 * 3. Search with that query and check:
 *    - Does the source turn appear in results? (recall)
 *    - At what rank? (MRR)
 *
 * Run: npx tsx bench/quality.ts
 */

import { SessionIndex } from "../extensions/session-index.js";
import { writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const HOME = process.env.HOME!;
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const DB_PATH = "/tmp/pi-quality-bench.db";
const RESULTS_PATH = join(import.meta.dirname, "fixtures/quality-results.json");

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

// Sample turns
const sampleRows = idx.db.prepare(`
  SELECT t.rowid, t.file_path, t.session_id, t.turn_index, t.byte_offset, t.byte_length
  FROM turn_offsets t ORDER BY RANDOM() LIMIT 200
`).all() as Array<{ rowid: number; file_path: string; session_id: string; turn_index: number; byte_offset: number; byte_length: number }>;

// Build test cases
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

console.log(`Generated ${testCases.length} test cases\n`);

// Run searches
let found = 0, totalRank = 0, rrSum = 0;
const details: Array<{ query: string; rank: number | null; totalResults: number }> = [];

for (const tc of testCases) {
  const results = idx.search(tc.query, { limit: 10, contextTurns: 0 });
  const matchIdx = results.findIndex(r =>
    r.sessionId === tc.expectedSessionId && r.turnIndex === tc.expectedTurnIndex
  );
  const rank = matchIdx >= 0 ? matchIdx + 1 : null;
  if (rank !== null) { found++; totalRank += rank; rrSum += 1 / rank; }
  details.push({ query: tc.query, rank, totalResults: results.length });
}

const n = testCases.length;
const recall = found / n;
const mrr = rrSum / n;
const avgRank = found > 0 ? totalRank / found : null;

console.log("=== Quality Results ===");
console.log(`Recall@10:  ${(recall * 100).toFixed(0)}% (${found}/${n})`);
console.log(`MRR:        ${mrr.toFixed(3)}`);
console.log(`Avg rank:   ${avgRank?.toFixed(1) ?? 'N/A'}`);

const rankDist = { 1: 0, 2: 0, 3: 0, '4-10': 0, miss: 0 };
for (const d of details) {
  if (d.rank === 1) rankDist[1]++;
  else if (d.rank === 2) rankDist[2]++;
  else if (d.rank === 3) rankDist[3]++;
  else if (d.rank !== null) rankDist['4-10']++;
  else rankDist.miss++;
}
console.log(`\nRank 1: ${rankDist[1]} | Rank 2: ${rankDist[2]} | Rank 3: ${rankDist[3]} | Rank 4-10: ${rankDist['4-10']} | Miss: ${rankDist.miss}`);

// Show misses
const misses = details.filter(d => d.rank === null).slice(0, 5);
if (misses.length > 0) {
  console.log(`\nSample misses: ${misses.map(m => `"${m.query}"`).join(', ')}`);
}

writeFileSync(RESULTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), summary: { n, recall, mrr, avgRank, rankDist }, details }, null, 2));
console.log(`\nFull results: ${RESULTS_PATH}`);

idx.close();
execSync(`rm -f ${DB_PATH}`);
