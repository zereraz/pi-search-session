/**
 * SessionIndex — unit + integration tests
 *
 * Uses node:test (no external test framework).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, test, before, after } from "node:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionIndex } from "../session-index.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-sessions");
const TEST_DB = join(import.meta.dirname, "../../.test-index.db");

// ── Test fixtures ────────────────────────────────────────────────────────

function makeSession(id: string, turns: Array<{ user: string; assistant: string; toolResult?: string }>) {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-05-01T00:00:00.000Z", cwd: "/tmp" }));

  let parentId: string | null = null;
  for (const turn of turns) {
    const uid = `u-${Math.random().toString(36).slice(2, 8)}`;
    lines.push(JSON.stringify({
      type: "message", id: uid, parentId, timestamp: "2026-05-01T10:00:00.000Z",
      message: { role: "user", content: turn.user }
    }));
    parentId = uid;

    const aid = `a-${Math.random().toString(36).slice(2, 8)}`;
    lines.push(JSON.stringify({
      type: "message", id: aid, parentId, timestamp: "2026-05-01T10:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: turn.assistant }] }
    }));
    parentId = aid;

    if (turn.toolResult) {
      const tid = `t-${Math.random().toString(36).slice(2, 8)}`;
      lines.push(JSON.stringify({
        type: "message", id: tid, parentId, timestamp: "2026-05-01T10:00:02.000Z",
        message: { role: "toolResult", content: [{ type: "text", text: turn.toolResult }] }
      }));
      parentId = tid;
    }
  }
  return lines.join("\n") + "\n";
}

// ── Setup / Teardown ─────────────────────────────────────────────────────

let idx: SessionIndex;

before(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(TEST_DB, { force: true });

  // Create test sessions
  const projectDir = join(TEST_DIR, "--test-project--");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(projectDir, "2026-05-01T00-00-00-000Z_session-1.jsonl"),
    makeSession("session-1", [
      { user: "How do I use SessionIndex?", assistant: "You create a new instance with a db path." },
      { user: "What about camelCase search?", assistant: "The expandCamelCase method splits identifiers.", toolResult: "readFileSync found in 3 files" },
    ])
  );

  writeFileSync(join(projectDir, "2026-05-01T00-00-00-000Z_session-2.jsonl"),
    makeSession("session-2", [
      { user: "Explain FTS5 contentless tables", assistant: "Contentless FTS5 stores only the inverted index, not the text." },
      { user: "How is BM25 ranking calculated?", assistant: "BM25 uses term frequency and inverse document frequency." },
    ])
  );

  // Session with compaction
  const compactionSession = makeSession("session-3", [
    { user: "Start working on the migration", assistant: "I'll begin the database migration." },
  ]);
  const compactionEntry = JSON.stringify({
    type: "compaction", id: "comp-1", parentId: null,
    timestamp: "2026-05-01T12:00:00.000Z",
    summary: "Working on database migration from PostgreSQL to SQLite",
    firstKeptEntryId: "u-1", tokensBefore: 5000
  });
  writeFileSync(join(projectDir, "2026-05-01T00-00-00-000Z_session-3.jsonl"),
    compactionSession + compactionEntry + "\n"
  );

  idx = new SessionIndex(TEST_DB, TEST_DIR);
});

after(() => {
  idx.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(TEST_DB, { force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("reindex", () => {
  test("indexes all files", async () => {
    const r = await idx.reindex();
    assert.equal(r.filesScanned, 3);
    assert.ok(r.turnsAdded >= 5); // 2 + 2 + 1 turns minimum
  });

  test("warm reindex adds nothing", async () => {
    const r = await idx.reindex();
    assert.equal(r.turnsAdded, 0);
  });

  test("stats reflect indexed content", () => {
    const s = idx.stats();
    assert.equal(s.totalFiles, 3);
    assert.ok(s.totalTurns >= 5);
    assert.ok(s.indexSizeBytes > 0);
  });
});

describe("search", () => {
  test("finds by keyword", () => {
    const results = idx.search("SessionIndex", { limit: 5, contextTurns: 0 });
    assert.ok(results.length > 0);
    assert.ok(results[0].text.includes("SessionIndex"));
  });

  test("finds camelCase by parts", () => {
    const results = idx.search("session index", { limit: 5, contextTurns: 0 });
    assert.ok(results.length > 0, "should find 'SessionIndex' by searching 'session index'");
  });

  test("BM25 scores are negative (better = more negative)", () => {
    const results = idx.search("FTS5", { limit: 5, contextTurns: 0 });
    assert.ok(results.length > 0);
    assert.ok(results[0].score < 0);
  });

  test("returns context turns when requested", () => {
    const results = idx.search("camelCase", { limit: 1, contextTurns: 1 });
    assert.ok(results.length > 0);
    assert.ok(results[0].context && results[0].context.length > 0);
  });

  test("session_id filter works", () => {
    const all = idx.search("FTS5", { limit: 10, contextTurns: 0 });
    const filtered = idx.search("FTS5", { limit: 10, contextTurns: 0, sessionId: "session-2" });
    assert.ok(filtered.length <= all.length);
    for (const r of filtered) {
      assert.equal(r.sessionId, "session-2");
    }
  });

  test("project filter works", () => {
    const results = idx.search("FTS5", { limit: 10, contextTurns: 0, project: "test-project" });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.sessionFile.includes("test-project"));
    }
  });

  test("time filter (after) works", () => {
    const future = "2099-01-01T00:00:00.000Z";
    const results = idx.search("FTS5", { limit: 10, contextTurns: 0, after: future });
    assert.equal(results.length, 0, "no results should exist after 2099");
  });

  test("empty query returns empty", () => {
    const results = idx.search("", { limit: 5, contextTurns: 0 });
    assert.equal(results.length, 0);
  });

  test("nonsense query returns empty", () => {
    const results = idx.search("xyzzy9999qqq", { limit: 5, contextTurns: 0 });
    assert.equal(results.length, 0);
  });

  test("indexes compaction summaries", () => {
    const results = idx.search("database migration", { limit: 5, contextTurns: 0 });
    assert.ok(results.length > 0, "should find compaction summary text");
  });

  test("indexes tool results", () => {
    const results = idx.search("readFileSync found", { limit: 5, contextTurns: 0 });
    assert.ok(results.length > 0, "should find tool result text");
  });

  test("result includes file path", () => {
    const results = idx.search("FTS5", { limit: 1, contextTurns: 0 });
    assert.ok(results[0].sessionFile.endsWith(".jsonl"));
  });
});

describe("sanitization", () => {
  test("handles FTS5 operators gracefully", () => {
    // Should not throw
    const r1 = idx.search("AND OR NOT", { limit: 1, contextTurns: 0 });
    assert.equal(r1.length, 0); // all stripped
  });

  test("handles special characters", () => {
    const r = idx.search("pi-session-search", { limit: 5, contextTurns: 0 });
    // Should not throw, hyphens get quoted
    assert.ok(Array.isArray(r));
  });

  test("handles unclosed quotes", () => {
    const r = idx.search('"unclosed quote', { limit: 1, contextTurns: 0 });
    assert.ok(Array.isArray(r)); // should not throw
  });
});

describe("incremental indexing", () => {
  test("detects file growth", async () => {
    const projectDir = join(TEST_DIR, "--test-project--");
    const filePath = join(projectDir, "2026-05-01T00-00-00-000Z_session-1.jsonl");

    // Append a new turn
    const newTurn = JSON.stringify({
      type: "message", id: "new-1", parentId: null,
      timestamp: "2026-05-02T00:00:00.000Z",
      message: { role: "user", content: "This is a uniqueAppendedTerm12345" }
    }) + "\n" + JSON.stringify({
      type: "message", id: "new-2", parentId: "new-1",
      timestamp: "2026-05-02T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Acknowledged." }] }
    }) + "\n";

    const { appendFileSync } = await import("fs");
    appendFileSync(filePath, newTurn);

    const r = await idx.reindex();
    assert.ok(r.turnsAdded > 0, "should index new content");

    const results = idx.search("uniqueAppendedTerm12345", { limit: 1, contextTurns: 0 });
    assert.equal(results.length, 1, "should find the appended term");
  });
});

describe("cleanup", () => {
  test("removes entries for deleted files", async () => {
    const projectDir = join(TEST_DIR, "--cleanup-test--");
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, "2026-05-01T00-00-00-000Z_cleanup.jsonl");
    writeFileSync(filePath, makeSession("cleanup-session", [
      { user: "cleanupUniqueXYZ999", assistant: "will be deleted" }
    ]));

    await idx.reindex();
    let results = idx.search("cleanupUniqueXYZ999", { limit: 1, contextTurns: 0 });
    assert.equal(results.length, 1, "should find before delete");

    // Delete the file
    rmSync(filePath);
    const removed = await idx.cleanup();
    assert.ok(removed > 0);

    results = idx.search("cleanupUniqueXYZ999", { limit: 1, contextTurns: 0 });
    assert.equal(results.length, 0, "should not find after cleanup");
  });
});
