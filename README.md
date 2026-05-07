# pi-session-search

Full-text search across all pi sessions. Contentless FTS5 index with BM25 ranking and O(1) byte-offset retrieval.

## Install

```bash
pi install github:zereraz/pi-search-session
```

## Tools

| Tool | Description |
|------|-------------|
| `search_sessions` | BM25-ranked search across all past sessions |
| `reindex_sessions` | Rebuild index incrementally (only new content) |

### `search_sessions` parameters

| Param | Description |
|-------|-------------|
| `query` | Natural language or keywords |
| `limit` | Max results (default: 5) |
| `project` | Filter by project directory name |
| `context_turns` | Surrounding turns for context (default: 1) |

Each result includes the source file path for deeper inspection.

## Design

**No data duplication.** The FTS5 index is contentless — it stores only the inverted index (term positions), not the text. Retrieval reads directly from pi's original JSONL session files via byte offsets.

**Turn granularity.** Each indexed document is one conversational turn: user message + assistant response + tool results. This means query terms must co-occur in the same exchange, eliminating false positives from scattered term matches.

**Incremental.** Per-file watermarks (`path, size, mtime, last_offset`) track what's already indexed. Only new bytes are processed on reindex.

**Proper cleanup.** Uses `contentless_delete=1` (SQLite ≥3.43) so deleted/rewritten session files are properly removed from the FTS index.

## Performance

Measured against 355 sessions (~30MB corpus):

| Metric | Value |
|--------|-------|
| Cold build | ~900ms |
| Warm reindex | 9ms |
| Search | 1-4ms |
| DB size | ~6MB (20% of corpus) |
| Turns indexed | 2529 |

## How it works

```
~/.pi/agent/sessions/          ← pi's JSONL session files (source of truth)
~/.pi/agent/session-index.db   ← FTS5 index (this package)

Indexing:
  1. Walk sessions dir, stat each .jsonl file
  2. Skip unchanged files (watermark match)
  3. Read new bytes from changed files
  4. Parse turns (user msg → assistant/tool responses)
  5. Insert into FTS5 + store byte offsets in turn_offsets table

Search:
  1. FTS5 MATCH query → BM25-ranked rowids
  2. Join with turn_offsets → get file path + byte offset
  3. pread() original JSONL at offset → parse turn text
  4. Fetch ±N surrounding turns for context
```

## Requirements

- `better-sqlite3` (native module — needs build tools: gcc/clang, make, python3)
- SQLite ≥3.43 (for `contentless_delete=1`)
- pi sessions at `~/.pi/agent/sessions/`

## License

MIT
