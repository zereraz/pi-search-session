/**
 * SessionIndex — Contentless FTS5 full-text search over JSONL session files.
 *
 * Architecture:
 *   - Indexes JSONL files at "turn" granularity (user msg + assistant response)
 *   - Contentless FTS5: stores only the inverted index, retrieves text via byte offsets
 *   - Per-file watermarks for incremental indexing (only new bytes processed)
 *   - BM25 ranking with porter stemming + camelCase expansion
 *
 * Schema:
 *   indexed_files(path, size, mtime_ms, last_offset)  — watermarks
 *   turn_offsets(file_path, session_id, turn_index, byte_offset, byte_length, timestamp)
 *   sessions_fts(text) — contentless-delete FTS5 with porter+unicode61
 *
 * JSONL format (pi-mono sessions, types from @mariozechner/pi-coding-agent):
 *   Line 0: SessionHeader { type: "session", version: 3, id, timestamp, cwd }
 *   Lines:  SessionEntry { type, id, parentId, timestamp, ... }
 *
 * Indexed entry types:
 *   - SessionMessageEntry (roles: "user" | "assistant" | "toolResult")
 *   - CompactionEntry (summary text — high-level session context)
 *   - BranchSummaryEntry (summary of branched conversation paths)
 *   - CustomMessageEntry (extension-injected searchable content)
 *
 * Skipped entry types:
 *   - ModelChangeEntry, ThinkingLevelChangeEntry (config, not text)
 *   - CustomEntry (opaque state, e.g. pi-goal state blobs)
 *   - LabelEntry, SessionInfoEntry (metadata, not searchable)
 *
 * Performance (356 files, 150MB, 2556 turns):
 *   Cold build: ~1200ms (126 MB/s)  |  Warm reindex: 9ms
 *   Search:     ~4ms (with context)  |  DB size: ~6MB
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import type {
  SessionHeader,
  SessionEntry,
  SessionMessageEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CustomMessageEntry,
  FileEntry,
} from '@mariozechner/pi-coding-agent';

// ─── Public Types ────────────────────────────────────────────────────────────

/** A single conversational turn (user question + assistant response + tool results) */
export interface Turn {
  sessionId: string;
  sessionFile: string;
  turnIndex: number;
  timestamp: string;
  byteOffset: number;
  byteLength: number;
  text: string;
}

/** A ranked search result with optional surrounding context */
export interface SearchResult {
  sessionId: string;
  sessionFile: string;
  turnIndex: number;
  timestamp: string;
  /** BM25 score (more negative = better match) */
  score: number;
  /** Parsed turn text (user + assistant + truncated tool results) */
  text: string;
  /** ±N surrounding turns for context */
  context?: Turn[];
}

export interface IndexStats {
  totalFiles: number;
  totalTurns: number;
  indexSizeBytes: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SESSIONS_DIR = join(
  process.env.HOME || homedir(),
  '.pi',
  'agent',
  'sessions'
);

/** Max chars of tool result text indexed per turn. 2000 captures 83% of tool outputs fully. */
const TOOL_RESULT_INDEX_CAP = 2000;

/** Max chars of tool result shown in search output. Full text available in source file. */
const TOOL_RESULT_DISPLAY_CAP = 300;

// ─── SessionIndex ────────────────────────────────────────────────────────────

export class SessionIndex {
  /** Exposed for advanced queries. Use with care — schema may change. */
  db: Database.Database;
  private sessionsDir: string;

  constructor(dbPath: string, sessionsDir: string = DEFAULT_SESSIONS_DIR) {
    this.sessionsDir = resolve(sessionsDir);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Incrementally index all session files.
   * Only processes new bytes since last indexed offset per file.
   * Safe to call frequently — skips unchanged files in ~9ms.
   */
  async reindex(): Promise<{ filesScanned: number; turnsAdded: number }> {
    let filesScanned = 0;
    let turnsAdded = 0;

    const filesToIndex: string[] = [];
    const projectDirs = await this.listProjectDirs();

    for (const projectDir of projectDirs) {
      const fullDir = join(this.sessionsDir, projectDir);
      let entries;
      try { entries = await fs.readdir(fullDir); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        filesToIndex.push(join(fullDir, entry));
      }
    }

    for (const filePath of filesToIndex) {
      const added = await this.indexFile(filePath);
      turnsAdded += added;
      filesScanned++;
    }

    return { filesScanned, turnsAdded };
  }

  /**
   * BM25-ranked full-text search across all indexed sessions.
   *
   * Returns turns where ALL query terms co-occur (implicit AND).
   * This turn-granularity constraint eliminates false positives from
   * scattered term matches across unrelated parts of a session.
   */
  search(query: string, options?: {
    limit?: number;
    contextTurns?: number;
    sessionId?: string;
    project?: string;
    /** ISO timestamp — only return turns after this date */
    after?: string;
  }): SearchResult[] {
    const limit = options?.limit ?? 10;
    const contextTurns = options?.contextTurns ?? 2;

    const ftsQuery = this.sanitizeFtsQuery(this.expandCamelCase(query));
    if (!ftsQuery) return [];

    let sql = `
      SELECT t.rowid, t.file_path, t.session_id, t.turn_index,
             t.byte_offset, t.byte_length, t.timestamp, rank
      FROM sessions_fts fts
      JOIN turn_offsets t ON fts.rowid = t.rowid
      WHERE sessions_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (options?.sessionId) {
      sql += ` AND t.session_id = ?`;
      params.push(options.sessionId);
    }
    if (options?.project) {
      sql += ` AND t.file_path LIKE ?`;
      params.push(`%${options.project}%`);
    }
    if (options?.after) {
      sql += ` AND t.timestamp > ?`;
      params.push(options.after);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      rowid: number; file_path: string; session_id: string;
      turn_index: number; byte_offset: number; byte_length: number;
      timestamp: string; rank: number;
    }>;

    const results = rows.map(row => {
      const text = this.readBytes(row.file_path, row.byte_offset, row.byte_length);
      const result: SearchResult = {
        sessionId: row.session_id,
        sessionFile: row.file_path,
        turnIndex: row.turn_index,
        timestamp: row.timestamp,
        score: row.rank,
        text: this.parseTurnText(text)
      };
      if (contextTurns > 0) {
        result.context = this.getSurroundingTurns(row.file_path, row.turn_index, contextTurns);
      }
      return result;
    });

    this.closeFdCache();
    return results;
  }

  /**
   * Regex search across all turns. Scans first 2KB of each turn.
   * For matched turns, shows a snippet around the match rather than full-parsing.
   * ~6-25ms for 2500 turns depending on pattern selectivity.
   */
  searchRegex(pattern: string, options?: {
    limit?: number;
    project?: string;
    sessionId?: string;
    after?: string;
  }): SearchResult[] {
    const limit = options?.limit ?? 10;
    let regex: RegExp;
    try { regex = new RegExp(pattern, 'ig'); } catch { return []; }

    let sql = 'SELECT file_path, session_id, turn_index, byte_offset, byte_length, timestamp FROM turn_offsets WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.sessionId) { sql += ' AND session_id = ?'; params.push(options.sessionId); }
    if (options?.project) { sql += ' AND file_path LIKE ?'; params.push(`%${options.project}%`); }
    if (options?.after) { sql += ' AND timestamp > ?'; params.push(options.after); }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      file_path: string; session_id: string; turn_index: number;
      byte_offset: number; byte_length: number; timestamp: string;
    }>;

    const results: SearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      // Read first 2KB — user messages + assistant start are almost always here
      const scanLen = Math.min(row.byte_length, 2000);
      const raw = this.readBytes(row.file_path, row.byte_offset, scanLen);
      regex.lastIndex = 0;
      const match = regex.exec(raw);
      if (!match) continue;

      // Extract snippet around match (avoid full parseTurnText for speed)
      const matchStart = Math.max(0, match.index - 80);
      const matchEnd = Math.min(raw.length, match.index + match[0].length + 80);
      const snippet = raw.slice(matchStart, matchEnd)
        .replace(/[\n\r]+/g, ' ')
        .replace(/\\["n]/g, ' ')
        .trim();

      results.push({
        sessionId: row.session_id,
        sessionFile: row.file_path,
        turnIndex: row.turn_index,
        timestamp: row.timestamp,
        score: 0,
        text: `...${snippet}...`,
      });
    }

    this.closeFdCache();
    return results;
  }

  /** Remove stale entries for deleted session files. Returns count removed. */
  async cleanup(): Promise<number> {
    const files = this.db.prepare('SELECT path FROM indexed_files').all() as Array<{ path: string }>;
    let removed = 0;
    for (const { path } of files) {
      try { await fs.access(path); } catch {
        this.removeFileEntries(path);
        removed++;
      }
    }
    return removed;
  }

  /** Index statistics. */
  stats(): IndexStats {
    const files = this.db.prepare('SELECT COUNT(*) as count FROM indexed_files').get() as { count: number };
    const turns = this.db.prepare('SELECT COUNT(*) as count FROM turn_offsets').get() as { count: number };
    let indexSize = 0;
    try {
      const pageCount = this.db.pragma('page_count') as Array<{ page_count: number }>;
      const pageSize = this.db.pragma('page_size') as Array<{ page_size: number }>;
      indexSize = (pageCount[0]?.page_count ?? 0) * (pageSize[0]?.page_size ?? 4096);
    } catch {}
    return { totalFiles: files.count, totalTurns: turns.count, indexSizeBytes: indexSize };
  }

  /** Merge FTS5 segments. Call periodically (e.g. weekly), not on every reindex. */
  optimize(): void {
    this.db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('optimize')");
  }

  /** Read raw bytes from a file at offset. Uses fd cache within a search. */
  readBytes(filePath: string, offset: number, length: number): string {
    try {
      const fd = this.getFd(filePath);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      return buffer.toString('utf-8');
    } catch {
      return '';
    }
  }

  /** Parse raw JSONL bytes of a turn into human-readable text. */
  parseTurnText(rawLines: string): string {
    const lines = rawLines.split('\n');
    const parts: string[] = [];

    for (const line of lines) {
      if (line.length < 20) continue;

      // Handle compaction/branch_summary entries (not messages but have searchable text)
      if (line.includes('"compaction"') || line.includes('"branch_summary"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.summary) parts.push(`[${obj.type}]: ${obj.summary}`);
        } catch {}
        continue;
      }

      if (!line.includes('"message"')) continue;

      try {
        let obj;
        // Perf: for large tool result lines (>4KB), truncate before JSON.parse.
        // We only display 300 chars anyway — no point parsing 50KB of output.
        if (line.length > 4000 && line.includes('toolResult')) {
          const truncated = line.slice(0, 4000);
          try { obj = JSON.parse(truncated + ']}]}'); } catch {
            try { obj = JSON.parse(truncated + '"}]}]}'); } catch {
              // Regex fallback for extremely malformed truncations
              const roleMatch = line.match(/"role":"(\w+)"/);
              if (roleMatch?.[1] === 'toolResult') {
                const textMatch = line.match(/"text":"([^"]{0,400})/);
                const snippet = textMatch?.[1] ?? '';
                parts.push(`[tool result]: ${snippet}...\n[Showing ${TOOL_RESULT_DISPLAY_CAP} of ${line.length} chars. Full output in source file above.]`);
              }
              continue;
            }
          }
        } else {
          obj = JSON.parse(line);
        }

        if (obj.type !== 'message') continue;
        const role = obj.message?.role;
        const text = this.extractText(obj.message?.content);

        if (text && role !== 'toolResult') {
          parts.push(`${role}: ${text}`);
        } else if (text && role === 'toolResult') {
          if (text.length > TOOL_RESULT_DISPLAY_CAP) {
            parts.push(`[tool result]: ${text.slice(0, TOOL_RESULT_DISPLAY_CAP)}...\n[Showing ${TOOL_RESULT_DISPLAY_CAP} of ${text.length} chars. Full output in source file above.]`);
          } else {
            parts.push(`[tool result]: ${text}`);
          }
        }
      } catch {}
    }

    return parts.join('\n\n');
  }

  close(): void {
    this.closeFdCache();
    this.db.close();
  }

  // ─── Indexing Internals ──────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        last_offset INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_offsets (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_session ON turn_offsets(session_id);
      CREATE INDEX IF NOT EXISTS idx_turn_file ON turn_offsets(file_path);
      CREATE INDEX IF NOT EXISTS idx_turn_timestamp ON turn_offsets(timestamp);

      -- contentless_delete=1 requires SQLite >=3.43
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        text,
        content='',
        contentless_delete=1,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
  }

  private async indexFile(filePath: string): Promise<number> {
    let stat;
    try { stat = await fs.stat(filePath); } catch { return 0; }

    const existing = this.db.prepare(
      'SELECT size, mtime_ms, last_offset FROM indexed_files WHERE path = ?'
    ).get(filePath) as { size: number; mtime_ms: number; last_offset: number } | undefined;

    // Skip unchanged files (fast path — ~9ms for 356 files)
    if (existing && existing.size === stat.size && existing.mtime_ms === Math.floor(stat.mtimeMs)) {
      return 0;
    }

    const startOffset = existing?.last_offset ?? 0;

    // File shrunk = rewritten (pi-mono migration). Re-index from scratch.
    if (existing && stat.size < existing.size) {
      this.removeFileEntries(filePath);
      return this.indexFileFromOffset(filePath, 0, stat);
    }

    return this.indexFileFromOffset(filePath, startOffset, stat);
  }

  private async indexFileFromOffset(
    filePath: string,
    startOffset: number,
    stat: { size: number; mtimeMs: number }
  ): Promise<number> {
    let fd: number | null = null;
    let content: string;
    try {
      fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(stat.size - startOffset);
      readSync(fd, buffer, 0, buffer.length, startOffset);
      content = buffer.toString('utf-8');
    } catch { return 0; }
    finally { if (fd !== null) closeSync(fd); }

    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    // Resolve session ID — needed to associate turns with sessions
    let sessionId = '';
    if (startOffset === 0) {
      try {
        const header = JSON.parse(lines[0]);
        if (header.type === 'session') sessionId = header.id;
      } catch {}
    } else {
      const row = this.db.prepare(
        'SELECT session_id FROM turn_offsets WHERE file_path = ? LIMIT 1'
      ).get(filePath) as { session_id: string } | undefined;
      sessionId = row?.session_id ?? '';
    }

    // Fallback: re-read first line from disk (handles resume after DB wipe)
    if (!sessionId) {
      let headerFd: number | null = null;
      try {
        headerFd = openSync(filePath, 'r');
        const headerBuf = Buffer.alloc(Math.min(1024, stat.size));
        readSync(headerFd, headerBuf, 0, headerBuf.length, 0);
        const firstLine = headerBuf.toString('utf-8').split('\n')[0];
        const header = JSON.parse(firstLine);
        if (header.type === 'session') sessionId = header.id;
      } catch {}
      finally { if (headerFd !== null) closeSync(headerFd); }
    }

    // Files without a valid session header are skipped (e.g. non-pi JSONL files)
    if (!sessionId) return 0;

    const maxTurnRow = this.db.prepare(
      'SELECT MAX(turn_index) as max_turn FROM turn_offsets WHERE file_path = ?'
    ).get(filePath) as { max_turn: number | null } | undefined;
    let turnIndex = (maxTurnRow?.max_turn ?? -1) + 1;

    let currentTurn: { text: string; byteOffset: number; byteEnd: number; timestamp: string } | null = null;
    let turnsAdded = 0;
    let lineOffset = startOffset;

    const insertTurn = this.db.prepare(
      'INSERT INTO turn_offsets (file_path, session_id, turn_index, byte_offset, byte_length, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertFts = this.db.prepare(
      'INSERT INTO sessions_fts (rowid, text) VALUES (?, ?)'
    );

    const flushTurn = () => {
      if (!currentTurn || !currentTurn.text.trim()) return;
      const byteLength = currentTurn.byteEnd - currentTurn.byteOffset;
      const result = insertTurn.run(filePath, sessionId, turnIndex, currentTurn.byteOffset, byteLength, currentTurn.timestamp);
      insertFts.run(result.lastInsertRowid, currentTurn.text);
      turnIndex++;
      turnsAdded++;
    };

    const transaction = this.db.transaction(() => {
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');
        if (!line.trim()) { lineOffset += lineBytes; continue; }

        let obj: FileEntry;
        try { obj = JSON.parse(line); } catch { lineOffset += lineBytes; continue; }

        // Index message entries (user/assistant/toolResult turns)
        if (obj.type === 'message' && (obj as SessionMessageEntry).message) {
          const msg = (obj as SessionMessageEntry).message;
          const role = msg.role;
          const content = msg.content;

          if (role === 'user') {
            flushTurn();
            currentTurn = {
              text: this.extractText(content),
              byteOffset: lineOffset,
              byteEnd: lineOffset + lineBytes,
              timestamp: String(obj.timestamp || '')
            };
          } else if (role === 'assistant' && currentTurn) {
            const text = this.extractText(content);
            if (text) currentTurn.text += '\n' + text;
            currentTurn.byteEnd = lineOffset + lineBytes;
          } else if (role === 'toolResult' && currentTurn) {
            const text = this.extractText(content);
            if (text) {
              const truncated = text.length > TOOL_RESULT_INDEX_CAP ? text.slice(0, TOOL_RESULT_INDEX_CAP) : text;
              currentTurn.text += '\n' + truncated;
            }
            currentTurn.byteEnd = lineOffset + lineBytes;
          }
        }
        // Index compaction summaries — high-level session context written by pi
        else if (obj.type === 'compaction' && (obj as CompactionEntry).summary) {
          const summary = (obj as CompactionEntry).summary;
          if (currentTurn) {
            currentTurn.text += '\n[compaction]: ' + this.expandCamelCase(summary);
            currentTurn.byteEnd = lineOffset + lineBytes;
          }
        }
        // Index branch summaries — summaries of branched-off conversation paths
        else if (obj.type === 'branch_summary' && (obj as BranchSummaryEntry).summary) {
          const summary = (obj as BranchSummaryEntry).summary;
          if (currentTurn) {
            currentTurn.text += '\n[branch_summary]: ' + this.expandCamelCase(summary);
            currentTurn.byteEnd = lineOffset + lineBytes;
          }
        }
        // Index custom_message content — extensions can inject searchable context
        else if (obj.type === 'custom_message' && (obj as CustomMessageEntry).content) {
          const cm = obj as CustomMessageEntry;
          const text = this.extractText(cm.content);
          if (text && currentTurn) {
            currentTurn.text += '\n' + text;
            currentTurn.byteEnd = lineOffset + lineBytes;
          }
        }
        // Skipped: model_change, thinking_level_change, custom (state-only), label, session_info
        lineOffset += lineBytes;
      }
      flushTurn();
      this.db.prepare(
        'INSERT OR REPLACE INTO indexed_files (path, size, mtime_ms, last_offset) VALUES (?, ?, ?, ?)'
      ).run(filePath, stat.size, Math.floor(stat.mtimeMs), stat.size);
    });

    transaction();
    return turnsAdded;
  }

  // ─── Text Extraction ─────────────────────────────────────────────────────

  /**
   * Expand camelCase so both compound and parts are searchable.
   * "readFileSync" → "readFileSync read File Sync"
   * Only applies to words ≥6 chars with a case transition.
   */
  private expandCamelCase(text: string): string {
    return text.replace(/\b([a-zA-Z]{6,})\b/g, (match) => {
      if (!/[a-z][A-Z]/.test(match) && !/[A-Z]{2,}[a-z]/.test(match)) return match;
      const parts = match
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      if (parts === match) return match;
      return `${match} ${parts}`;
    });
  }

  /**
   * Extract searchable text from a pi-ai message content field.
   * Handles: string content, TextContent blocks, ToolCall blocks.
   * Skips: ThinkingContent (internal), ImageContent (binary).
   */
  private extractText(content: unknown): string {
    if (!content) return '';
    if (typeof content === 'string') return this.expandCamelCase(content);

    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type: string; text?: string; name?: string };
        switch (b.type) {
          case 'text':
            if (typeof b.text === 'string') texts.push(b.text);
            break;
          case 'toolCall':
            if (typeof b.name === 'string') texts.push(`[tool:${b.name}]`);
            break;
        }
      }
      return this.expandCamelCase(texts.join('\n'));
    }
    return '';
  }

  // ─── Search Helpers ──────────────────────────────────────────────────────

  /** FD cache — reuse file descriptors within a single search call. */
  private fdCache = new Map<string, number>();

  private getFd(filePath: string): number {
    let fd = this.fdCache.get(filePath);
    if (fd === undefined) {
      fd = openSync(filePath, 'r');
      this.fdCache.set(filePath, fd);
    }
    return fd;
  }

  private closeFdCache(): void {
    for (const fd of this.fdCache.values()) {
      try { closeSync(fd); } catch {}
    }
    this.fdCache.clear();
  }

  /** Cached prepared statement for context lookups. */
  private _stmtSurrounding: ReturnType<typeof this.db.prepare> | null = null;
  private get stmtSurrounding() {
    if (!this._stmtSurrounding) {
      this._stmtSurrounding = this.db.prepare(`
        SELECT rowid, file_path, session_id, turn_index, byte_offset, byte_length, timestamp
        FROM turn_offsets
        WHERE file_path = ? AND turn_index BETWEEN ? AND ? AND turn_index != ?
        ORDER BY turn_index
      `);
    }
    return this._stmtSurrounding;
  }

  /**
   * Lightweight context turn parser. Only reads first 1.5KB and extracts
   * user message + brief assistant preview. Full parseTurnText would be
   * expensive here (context turns avg 12KB, mostly tool output).
   */
  private parseContextTurnText(filePath: string, offset: number, length: number): string {
    const readLen = Math.min(length, 1500);
    const raw = this.readBytes(filePath, offset, readLen);
    const lines = raw.split('\n');
    const parts: string[] = [];

    for (const line of lines) {
      if (line.length < 20 || !line.includes('"message"')) continue;
      try {
        if (line.includes('"user"')) {
          const obj = JSON.parse(line);
          if (obj.type === 'message' && obj.message?.role === 'user') {
            const text = this.extractText(obj.message.content);
            if (text) parts.push(`user: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
          }
        } else if (line.includes('"assistant"') && parts.length > 0) {
          const textMatch = line.match(/"text":"([^"]{0,150})/);
          if (textMatch) parts.push(`assistant: ${textMatch[1]}...`);
          break;
        }
      } catch { continue; }
    }
    return parts.join('\n\n') || '(context turn)';
  }

  private getSurroundingTurns(filePath: string, turnIndex: number, range: number): Turn[] {
    const rows = this.stmtSurrounding.all(
      filePath, Math.max(0, turnIndex - range), turnIndex + range, turnIndex
    ) as Array<{ rowid: number; file_path: string; session_id: string; turn_index: number; byte_offset: number; byte_length: number; timestamp: string }>;

    return rows.map(row => ({
      sessionId: row.session_id,
      sessionFile: row.file_path,
      turnIndex: row.turn_index,
      timestamp: row.timestamp,
      byteOffset: row.byte_offset,
      byteLength: row.byte_length,
      text: this.parseContextTurnText(row.file_path, row.byte_offset, row.byte_length)
    }));
  }

  // ─── Maintenance ─────────────────────────────────────────────────────────

  /**
   * Remove all index entries for a file.
   * Uses contentless_delete=1 for proper FTS cleanup (no orphaned entries).
   */
  private removeFileEntries(filePath: string): void {
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare(
        'SELECT rowid FROM turn_offsets WHERE file_path = ?'
      ).all(filePath) as Array<{ rowid: number }>;

      const deleteFts = this.db.prepare('DELETE FROM sessions_fts WHERE rowid = ?');
      for (const row of rows) deleteFts.run(row.rowid);

      this.db.prepare('DELETE FROM turn_offsets WHERE file_path = ?').run(filePath);
      this.db.prepare('DELETE FROM indexed_files WHERE path = ?').run(filePath);
    });
    transaction();
  }

  private async listProjectDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch { return []; }
  }

  // ─── Query Sanitization ──────────────────────────────────────────────────

  /**
   * Sanitize user query for FTS5 syntax.
   * - Strips FTS5 operators (AND/OR/NOT/NEAR) when used as bare words
   * - Quotes terms with special chars (hyphens, dots, slashes)
   * - Balances unclosed quotes
   */
  private sanitizeFtsQuery(query: string): string {
    if (!query || !query.trim()) return '';

    const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
    const terms = query.split(/\s+/).filter(Boolean);

    const sanitized = terms
      .map(term => {
        if (FTS5_OPERATORS.has(term.toUpperCase()) && term === term.toUpperCase()) return null;
        const cleaned = term.replace(/^[()]+|[()]+$/g, '');
        if (!cleaned) return null;
        if (/[\-:.@\/\\*()]/.test(cleaned)) {
          return `"${cleaned.replace(/"/g, '""')}"`;
        }
        return cleaned;
      })
      .filter(Boolean)
      .join(' ');

    if (!sanitized) return '';

    // Balance unclosed quotes (FTS5 throws on odd quote count)
    const quoteCount = (sanitized.match(/"/g) || []).length;
    return quoteCount % 2 !== 0 ? sanitized + '"' : sanitized;
  }
}
