# pi-session-search

Full-text search across all pi sessions. Contentless FTS5 index with BM25 ranking.

## Install

```bash
pi install github:zereraz/pi-search-session
```

## Tools

### `search_sessions`

```
query="vllm caching" ──► FTS5 MATCH ──► BM25 rank ──► pread(file, offset) ──► result
                              │
pattern="ERR_\w+" ──────► scan 2KB/turn ──► regex.exec ──► snippet ──► result
                              │
query + pattern ──────► FTS5 first ──► regex post-filter ──► result
```

| Param | Description |
|-------|-------------|
| `query` | Keywords (FTS5). Optional if `pattern` provided |
| `pattern` | Regex. Standalone or post-filter on `query` |
| `limit` | Max results (default: 5) |
| `project` | Filter by project name |
| `session_id` | Filter to specific session |
| `time_range` | `'day'`, `'week'`, `'month'`, `'year'`, or ISO date |
| `context_turns` | Surrounding turns (default: 1) |

Results include source file path — agent can `read` for full content.

### `reindex_sessions`

```
stat each .jsonl ──► compare watermark ──► read delta bytes ──► parse turns ──► FTS5 insert
     356 files          skip unchanged         only new bytes       ~9ms warm
```

## How it works

```
~/.pi/agent/sessions/**/*.jsonl        (source of truth, 150MB)
         │
         ▼  reindex (watermark per file, only new bytes)
         │
~/.pi/agent/session-index.db           (FTS5 inverted index, 6MB)
         │
         ▼  search
         │
    FTS5: inverted index O(1) → pread at byte offset → parse
    Regex: scan 2KB × 2578 turns (5MB) → snippet around match
```

## Performance

| Operation | Time |
|-----------|------|
| Cold index (356 files, 150MB) | ~1200ms |
| Warm reindex | 9ms |
| FTS5 search (with context) | ~4ms |
| Regex search | 2-15ms |

Regex beats ripgrep (0.2-0.9x) because we scan 5MB (2KB/turn) vs rg's 150MB.
Trade-off: matches deep in tool output (>2KB) are missed.

## Requirements

- `better-sqlite3` (native, needs build tools)
- SQLite ≥3.43
- pi sessions at `~/.pi/agent/sessions/`

## Development

```bash
npm test              # 31 tests
npm run bench         # precision/recall
npm run bench:rg      # FTS5 vs rg quality
npm run bench:regex   # regex vs rg speed
npm run bench:perf    # FTS5 speed
```

## License

MIT
