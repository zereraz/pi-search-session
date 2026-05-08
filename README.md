# pi-session-search

Search across all past pi sessions — find conversations, code, errors, decisions.

The agent gets instant recall of everything you've discussed across all sessions,
without loading full transcripts into context.

## Why

Without this, the agent has no memory between sessions. With this:
- "Find that vllm discussion from last week" → 4ms, ranked by relevance
- "Which session had the ERR_MODULE error?" → regex scan, 12ms
- "What did we decide about the memory store?" → finds the exact turn

vs `rg` over session files:
- No ranking (rg just finds files, not relevant turns)
- No turn boundaries (matches scattered across unrelated exchanges)
- No filtering (project, time, session)

## Install

```bash
pi install github:zereraz/pi-search-session
```

## Tools

### `search_sessions`

```
query="vllm caching" ──► FTS5 MATCH ──► BM25 rank ──► pread(file, offset) ──► result
pattern="ERR_\w+" ──────► scan 2KB/turn ──► regex.exec ──► snippet ──► result
query + pattern ────────► FTS5 first ──► regex post-filter ──► result
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
         ▼  reindex (per-file watermark, only new bytes)
         │
~/.pi/agent/session-index.db           (FTS5 inverted index, 6MB)
         │
         ▼  search
         │
    FTS5: inverted index O(1) → pread at byte offset → parse
    Regex: scan 2KB × 2578 turns (5MB) → snippet around match
```

## Performance

| Operation | Time | Notes |
|-----------|------|-------|
| Cold index (356 files, 150MB) | ~1200ms | One-time, 126 MB/s |
| Warm reindex | 9ms | Just stats 356 files |
| FTS5 search (with context) | ~4ms | Inverted index + pread |
| Regex search | 2-15ms | 5MB scan, beats rg |

### vs grep/ripgrep

**FTS5 mode** (quality, 50 random test cases):
- Recall@10: ~75% vs rg's ~51% — finds the right turn more often
- MRR: 0.58 vs 0.26 — ranks correct result higher
- 3x more likely to be the #1 result

**Regex mode** (speed, 8 patterns):
- 0.2x–0.9x of ripgrep's time (faster on all tested patterns)
- We scan 5MB (2KB/turn), rg scans 150MB (full files)
- We return turns with metadata, rg returns file paths

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
