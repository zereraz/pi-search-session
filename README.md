# pi-session-search

Full-text search across all pi sessions. Contentless FTS5 index with O(1) byte-offset retrieval.

## Install

```bash
pi install github:zereraz/pi-session-search
```

Or locally:
```bash
pi install /path/to/pi-session-search
```

## What it does

Indexes all your pi sessions at turn granularity (user message + assistant response as one document). Searches via BM25 ranking with sub-millisecond retrieval.

### Tools registered

| Tool | Description |
|------|-------------|
| `search_sessions` | BM25-ranked full-text search across all past sessions |
| `reindex_sessions` | Rebuild index incrementally (only new content) |

### Search parameters

- `query` — natural language or keywords
- `limit` — max results (default: 5)
- `project` — filter by project directory name
- `context_turns` — surrounding turns for context (default: 1)

## How it works

- **No data duplication** — contentless FTS5 stores only the inverted index (~13% of corpus size)
- **Incremental** — per-file watermarks track what's already indexed; reindex is ~7ms for no changes
- **O(1) retrieval** — byte offsets into original JSONL files, no scanning
- **Turn granularity** — user + assistant exchange as one doc for coherent BM25 ranking
- **Tool results capped** — 2000 chars in index (captures 83% fully, avoids noise)

## Performance

Benchmarked against 277 sessions, 25MB corpus:

| Metric | Value |
|--------|-------|
| Index size | 3.3MB (13% of corpus) |
| Cold build | 384ms |
| Warm reindex | 7ms |
| Search avg | 3.8ms/query |
| Precision | 76% (all query terms in same turn) |

## Library usage

```typescript
import { SessionIndex } from "pi-session-search";

const index = new SessionIndex("./index.db", "~/.pi/agent/sessions");
await index.reindex();

const results = index.search("database migration error", {
  limit: 10,
  contextTurns: 2,
  project: "my-app",
});
```

## Requirements

- `better-sqlite3` (native module, needs build tools)
- pi sessions at `~/.pi/agent/sessions/`

## License

MIT
