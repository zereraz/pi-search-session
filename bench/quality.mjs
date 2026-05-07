#!/usr/bin/env node
/**
 * Quality benchmark: Precision & Recall for session search
 *
 * Method:
 * 1. Sample N real turns from the index (these are our "ground truth" documents)
 * 2. For each turn, extract a query (distinctive phrase from the turn text)
 * 3. Search with that query and check:
 *    - Does the source turn appear in results? (recall)
 *    - At what rank? (precision / MRR)
 *    - How many irrelevant results appear before it? (noise)
 *
 * This gives us a real-world quality measure: "if I remember something from a
 * past session, can the search find it?"
 *
 * Run: node bench/quality.mjs
 * Output goes to bench/fixtures/quality-results.json (gitignored)
 */

import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { join, dirname } from "path";

const jiti = createJiti(fileURLToPath(import.meta.url));
const { SessionIndex } = jiti(join(dirname(fileURLToPath(import.meta.url)), "../extensions/session-index.ts"));

const HOME = process.env.HOME;
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const DB_PATH = "/tmp/pi-quality-bench.db";
const RESULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/quality-results.json");

const idx = new SessionIndex(DB_PATH, SESSIONS_DIR);
await idx.reindex();
const stats = idx.stats();

console.log(`Index: ${stats.totalFiles} files, ${stats.totalTurns} turns\n`);

// Sample turns that have meaningful user text (not just "yes" or "ok")
const sampleRows = idx.db.prepare(`
  SELECT t.rowid, t.file_path, t.session_id, t.turn_index, t.byte_offset, t.byte_length
  FROM turn_offsets t
  ORDER BY RANDOM()
  LIMIT 200
`).all();

// Extract queries from sampled turns
function extractQuery(turnText) {
  // Get the user message part
  const lines = turnText.split('\n');
  const userLine = lines.find(l => l.startsWith('user:'));
  if (!userLine) return null;

  const text = userLine.replace(/^user:\s*/, '');
  // Skip very short messages
  if (text.length < 20) return null;
  // Skip messages that are just pasted content
  if (text.length > 500) return null;

  // Extract 3-5 distinctive words (skip common ones)
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'can', 'this', 'that', 'these', 'those', 'it', 'its',
    'we', 'they', 'them', 'our', 'your', 'my', 'his', 'her', 'what', 'which',
    'who', 'when', 'where', 'how', 'why', 'if', 'then', 'else', 'for', 'from',
    'with', 'about', 'into', 'not', 'but', 'and', 'or', 'so', 'just', 'also',
    'too', 'very', 'really', 'all', 'any', 'some', 'no', 'yes', 'ok', 'sure',
    'let', 'me', 'you', 'to', 'of', 'in', 'on', 'at', 'by', 'up', 'out']);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  if (words.length < 2) return null;

  // Pick 2-4 words spaced apart (not adjacent to avoid exact phrase matching bias)
  const picked = [];
  const step = Math.max(1, Math.floor(words.length / 4));
  for (let i = 0; i < words.length && picked.length < 4; i += step) {
    picked.push(words[i]);
  }

  if (picked.length < 2) return null;
  return picked.join(' ');
}

// Read turn text and build test cases
const testCases = [];
for (const row of sampleRows) {
  if (testCases.length >= 50) break;

  const rawText = idx.readBytes(row.file_path, row.byte_offset, row.byte_length);
  const turnText = idx.parseTurnText(rawText);
  const query = extractQuery(turnText);

  if (query) {
    testCases.push({
      query,
      expectedSessionId: row.session_id,
      expectedTurnIndex: row.turn_index,
      expectedFile: row.file_path,
      sourceRowid: row.rowid,
    });
  }
}

console.log(`Generated ${testCases.length} test cases from random turns\n`);

// Run searches and measure quality
let found = 0;
let totalRank = 0;
let reciprocalRankSum = 0;
const details = [];

for (const tc of testCases) {
  const results = idx.search(tc.query, { limit: 10, contextTurns: 0 });

  // Check if source turn is in results
  const matchIdx = results.findIndex(r =>
    r.sessionId === tc.expectedSessionId && r.turnIndex === tc.expectedTurnIndex
  );

  const rank = matchIdx >= 0 ? matchIdx + 1 : null;
  if (rank !== null) {
    found++;
    totalRank += rank;
    reciprocalRankSum += 1 / rank;
  }

  details.push({
    query: tc.query,
    expectedSession: tc.expectedSessionId,
    expectedTurn: tc.expectedTurnIndex,
    rank,
    totalResults: results.length,
    topScore: results[0]?.score?.toFixed(2) ?? null,
  });
}

const recall = found / testCases.length;
const mrr = reciprocalRankSum / testCases.length;
const avgRank = found > 0 ? totalRank / found : null;

console.log("=== Quality Results ===");
console.log(`Test cases:     ${testCases.length}`);
console.log(`Found (recall): ${found}/${testCases.length} = ${(recall * 100).toFixed(1)}%`);
console.log(`MRR:            ${mrr.toFixed(3)} (1.0 = always rank 1)`);
console.log(`Avg rank:       ${avgRank?.toFixed(1) ?? 'N/A'} (when found)`);
console.log(`Not found:      ${testCases.length - found}`);

// Breakdown by rank
const rankDist = { 1: 0, 2: 0, 3: 0, '4-10': 0, miss: 0 };
for (const d of details) {
  if (d.rank === 1) rankDist[1]++;
  else if (d.rank === 2) rankDist[2]++;
  else if (d.rank === 3) rankDist[3]++;
  else if (d.rank !== null) rankDist['4-10']++;
  else rankDist.miss++;
}

console.log(`\nRank distribution:`);
console.log(`  Rank 1:  ${rankDist[1]} (${(rankDist[1]/testCases.length*100).toFixed(0)}%)`);
console.log(`  Rank 2:  ${rankDist[2]} (${(rankDist[2]/testCases.length*100).toFixed(0)}%)`);
console.log(`  Rank 3:  ${rankDist[3]} (${(rankDist[3]/testCases.length*100).toFixed(0)}%)`);
console.log(`  Rank 4-10: ${rankDist['4-10']} (${(rankDist['4-10']/testCases.length*100).toFixed(0)}%)`);
console.log(`  Miss:    ${rankDist.miss} (${(rankDist.miss/testCases.length*100).toFixed(0)}%)`);

// Show some misses for debugging
const misses = details.filter(d => d.rank === null).slice(0, 5);
if (misses.length > 0) {
  console.log(`\nSample misses (query → expected session):`);
  for (const m of misses) {
    console.log(`  "${m.query}" → session ${m.expectedSession.slice(0,8)} turn ${m.expectedTurn}`);
  }
}

// Save full results (gitignored)
writeFileSync(RESULTS_PATH, JSON.stringify({
  timestamp: new Date().toISOString(),
  stats: { totalFiles: stats.totalFiles, totalTurns: stats.totalTurns },
  summary: { testCases: testCases.length, recall, mrr, avgRank, rankDist },
  details,
}, null, 2));
console.log(`\nFull results saved to: ${RESULTS_PATH}`);

idx.close();
import { execSync } from "child_process";
execSync(`rm -f ${DB_PATH}`);
