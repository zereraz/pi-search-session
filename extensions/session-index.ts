/**
 * Session Index — contentless FTS5 over pi's existing JSONL sessions
 *
 * No data duplication. Indexes turns (user message + assistant response) at
 * byte-offset granularity for O(1) retrieval via pread.
 *
 * Pi sessions live at: ~/.pi/agent/sessions/<project-dir>/<timestamp>_<uuid>.jsonl
 * Each line is a JSON object with {type, id, parentId, ...}
 * Message lines have: {type: "message", message: {role, content, ...}}
 *
 * Design:
 * 1. indexed_files — per-file watermark (path, size, mtime, last_offset)
 * 2. turn_offsets — maps FTS rowid → (file, byte_offset, byte_length, session_id, turn_index, timestamp)
 * 3. sessions_fts — contentless FTS5, stores only the inverted index
 *
 * Index at turn granularity: user message + all assistant/toolResult messages until next user message.
 * This gives BM25 coherent context to rank against queries.
 *
 * Uses pi-ai types (UserMessage, AssistantMessage, ToolResultMessage) for
 * type-safe content extraction from JSONL lines.
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';

/** A turn: user question + assistant response (may include tool calls/results) */
export interface Turn {
  sessionId: string;
  sessionFile: string;
  turnIndex: number;
  timestamp: string;
  byteOffset: number;
  byteLength: number;
  /** Extracted text content of the turn (user + assistant text) */
  text: string;
}

/** Search result pointing back to the original JSONL */
export interface SearchResult {
  sessionId: string;
  sessionFile: string;
  turnIndex: number;
  timestamp: string;
  score: number;
  /** The raw turn text, retrieved via pread from the original file */
  text: string;
  /** Surrounding turns for context (±N) */
  context?: Turn[];
}

export interface IndexStats {
  totalFiles: number;
  totalTurns: number;
  indexSizeBytes: number;
}

const DEFAULT_SESSIONS_DIR = join(
  process.env.HOME || homedir(),
  '.pi',
  'agent',
  'sessions'
);

export class SessionIndex {
  db: Database.Database;
  private sessionsDir: string;

  constructor(
    dbPath: string,
    sessionsDir: string = DEFAULT_SESSIONS_DIR
  ) {
    this.sessionsDir = resolve(sessionsDir);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      -- Per-file watermark for incremental indexing
      CREATE TABLE IF NOT EXISTS indexed_files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        last_offset INTEGER NOT NULL
      );

      -- Turn location mapping: FTS rowid → file location
      CREATE TABLE IF NOT EXISTS turn_offsets (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_turn_session
        ON turn_offsets(session_id);
      CREATE INDEX IF NOT EXISTS idx_turn_file
        ON turn_offsets(file_path);

      -- Contentless-delete FTS5 — stores only the inverted index, not the text
      -- contentless_delete=1 enables proper DELETE support (SQLite >=3.43)
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        text,
        content='',
        contentless_delete=1,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Incrementally index all session files.
   * Only processes new bytes since last indexed offset per file.
   */
  async reindex(): Promise<{ filesScanned: number; turnsAdded: number }> {
    let filesScanned = 0;
    let turnsAdded = 0;

    // Walk sessions directory
    const projectDirs = await this.listProjectDirs();

    for (const projectDir of projectDirs) {
      const fullDir = join(this.sessionsDir, projectDir);
      let entries;
      try {
        entries = await fs.readdir(fullDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;

        const filePath = join(fullDir, entry);
        const added = await this.indexFile(filePath);
        turnsAdded += added;
        filesScanned++;
      }
    }

    return { filesScanned, turnsAdded };
  }

  /**
   * Index a single JSONL file incrementally from its last watermark.
   */
  private async indexFile(filePath: string): Promise<number> {
    // Check watermark
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return 0;
    }

    const existing = this.db.prepare(
      'SELECT size, mtime_ms, last_offset FROM indexed_files WHERE path = ?'
    ).get(filePath) as { size: number; mtime_ms: number; last_offset: number } | undefined;

    // Skip if file hasn't changed
    if (existing &&
        existing.size === stat.size &&
        existing.mtime_ms === Math.floor(stat.mtimeMs)) {
      return 0;
    }

    const startOffset = existing?.last_offset ?? 0;

    // If file shrunk (rewritten), re-index from scratch
    if (existing && stat.size < existing.size) {
      this.removeFileEntries(filePath);
      return this.indexFileFromOffset(filePath, 0, stat);
    }

    return this.indexFileFromOffset(filePath, startOffset, stat);
  }

  /**
   * Parse JSONL from a byte offset and index new turns.
   */
  private async indexFileFromOffset(
    filePath: string,
    startOffset: number,
    stat: { size: number; mtimeMs: number }
  ): Promise<number> {
    // Read the file content from startOffset
    let fd: number | null = null;
    let content: string;
    try {
      fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(stat.size - startOffset);
      readSync(fd, buffer, 0, buffer.length, startOffset);
      content = buffer.toString('utf-8');
    } catch {
      return 0;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    // Split into lines, removing trailing empty element from final newline
    const lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    // We need to know the session ID. If starting from 0, the first line is the session header.
    // If resuming, we need it from the DB or re-read line 0.
    let sessionId = '';
    if (startOffset === 0) {
      // First line should be the session header
      try {
        const header = JSON.parse(lines[0]);
        if (header.type === 'session') {
          sessionId = header.id;
        }
      } catch {}
    } else {
      // Get session ID from existing entries for this file
      const row = this.db.prepare(
        'SELECT session_id FROM turn_offsets WHERE file_path = ? LIMIT 1'
      ).get(filePath) as { session_id: string } | undefined;
      sessionId = row?.session_id ?? '';
    }

    if (!sessionId) {
      // Can't index without session ID — try reading first line of file
      let headerFd: number | null = null;
      try {
        headerFd = openSync(filePath, 'r');
        const headerBuf = Buffer.alloc(Math.min(1024, stat.size));
        readSync(headerFd, headerBuf, 0, headerBuf.length, 0);
        const firstLine = headerBuf.toString('utf-8').split('\n')[0];
        const header = JSON.parse(firstLine);
        if (header.type === 'session') sessionId = header.id;
      } catch {}
      finally {
        if (headerFd !== null) closeSync(headerFd);
      }
    }

    if (!sessionId) return 0;

    // Get current max turn index for this file
    const maxTurnRow = this.db.prepare(
      'SELECT MAX(turn_index) as max_turn FROM turn_offsets WHERE file_path = ?'
    ).get(filePath) as { max_turn: number | null } | undefined;
    let turnIndex = (maxTurnRow?.max_turn ?? -1) + 1;

    // Parse lines into turns
    // A turn starts with a user message and includes everything until the next user message
    let currentTurn: {
      text: string;
      byteOffset: number;
      byteEnd: number;
      timestamp: string;
    } | null = null;

    let turnsAdded = 0;
    let lineOffset = startOffset;

    const insertTurn = this.db.prepare(`
      INSERT INTO turn_offsets (file_path, session_id, turn_index, byte_offset, byte_length, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.prepare(`
      INSERT INTO sessions_fts (rowid, text) VALUES (?, ?)
    `);

    const flushTurn = () => {
      if (!currentTurn || !currentTurn.text.trim()) return;

      const byteLength = currentTurn.byteEnd - currentTurn.byteOffset;

      const result = insertTurn.run(
        filePath,
        sessionId,
        turnIndex,
        currentTurn.byteOffset,
        byteLength,
        currentTurn.timestamp
      );

      // Insert into FTS with matching rowid
      insertFts.run(result.lastInsertRowid, currentTurn.text);

      turnIndex++;
      turnsAdded++;
    };

    const transaction = this.db.transaction(() => {
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');

        if (!line.trim()) {
          lineOffset += lineBytes;
          continue;
        }

        let obj: { type: string; message?: { role?: string; content?: unknown; timestamp?: number | string }; id?: string; timestamp?: string };
        try {
          obj = JSON.parse(line);
        } catch {
          lineOffset += lineBytes;
          continue;
        }

        if (obj.type === 'message' && obj.message) {
          const role = obj.message.role;
          const content = obj.message.content;

          if (role === 'user') {
            // Flush previous turn
            flushTurn();

            // Start new turn
            const text = this.extractText(content);
            currentTurn = {
              text,
              byteOffset: lineOffset,
              byteEnd: lineOffset + lineBytes,
              timestamp: String(obj.timestamp || obj.message?.timestamp || '')
            };
          } else if (role === 'assistant' && currentTurn) {
            // Append assistant text to current turn
            const text = this.extractText(content);
            if (text) {
              currentTurn.text += '\n' + text;
            }
            currentTurn.byteEnd = lineOffset + lineBytes;
          } else if (role === 'toolResult' && currentTurn) {
            // Tool results are part of the turn but we only index
            // a brief summary to avoid noise from huge tool outputs
            const text = this.extractText(content);
            if (text) {
              // Cap tool result text — 2000 chars captures 83% fully,
              // balances index size vs search coverage
              const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
              currentTurn.text += '\n' + truncated;
            }
            currentTurn.byteEnd = lineOffset + lineBytes;
          }
        }

        lineOffset += lineBytes;
      }

      // Flush last turn
      flushTurn();

      // Update watermark — use actual file size, not computed offset, to avoid drift
      this.db.prepare(`
        INSERT OR REPLACE INTO indexed_files (path, size, mtime_ms, last_offset)
        VALUES (?, ?, ?, ?)
      `).run(filePath, stat.size, Math.floor(stat.mtimeMs), stat.size);
    });

    transaction();
    return turnsAdded;
  }

  /**
   * Extract text content from a pi message content field.
   * Uses pi-ai types for proper content block handling:
   * - TextContent → indexed
   * - ToolCall → indexed as [tool:name]
   * - ThinkingContent → skipped (internal reasoning)
   * - ImageContent → skipped (binary)
   */
  /**
   * Expand camelCase identifiers so both the compound and parts are searchable.
   * "readFileSync" → "readFileSync read File Sync"
   * "SessionIndex" → "SessionIndex Session Index"
   * "getHTTPResponse" → "getHTTPResponse get HTTP Response"
   * Only expands tokens ≥6 chars with at least one case transition.
   */
  private expandCamelCase(text: string): string {
    return text.replace(/\b([a-zA-Z]{6,})\b/g, (match) => {
      // Must have at least one lowercase→uppercase transition
      if (!/[a-z][A-Z]/.test(match) && !/[A-Z]{2,}[a-z]/.test(match)) return match;
      const parts = match
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      if (parts === match) return match;
      return `${match} ${parts}`;
    });
  }

  private extractText(content: unknown): string {
    if (!content) return '';

    // UserMessage can have string content
    if (typeof content === 'string') return this.expandCamelCase(content);

    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;

        const b = block as { type: string; text?: string; name?: string; thinking?: string };

        switch (b.type) {
          case 'text':
            // TextContent from pi-ai
            if (typeof b.text === 'string') texts.push(b.text);
            break;
          case 'toolCall':
            // ToolCall from pi-ai — index tool name for searchability
            if (typeof b.name === 'string') texts.push(`[tool:${b.name}]`);
            break;
          // Skip: 'thinking' (ThinkingContent) — internal reasoning
          // Skip: 'image' (ImageContent) — binary data
          // Skip: unknown types — safe to ignore
        }
      }
      return this.expandCamelCase(texts.join('\n'));
    }

    return '';
  }

  /**
   * Search sessions using FTS5 BM25 ranking.
   *
   * Indexes at turn granularity (user + assistant exchange as one document).
   * This means all query terms must appear in the same conversational turn,
   * which filters out false positives where terms are scattered across
   * unrelated parts of a session file.
   *
   * Tool result text is capped at 2000 chars in the index for ranking quality.
   * This captures 83% of tool outputs fully; for the rest, the first 2000 chars
   * usually contain the meaningful content (commands, errors, headers).
   */
  search(query: string, options?: {
    limit?: number;
    contextTurns?: number;
    sessionId?: string;
    project?: string;
  }): SearchResult[] {
    const limit = options?.limit ?? 10;
    const contextTurns = options?.contextTurns ?? 2;

    // Expand camelCase in query, then sanitize for FTS5
    const ftsQuery = this.sanitizeFtsQuery(this.expandCamelCase(query));
    if (!ftsQuery) return [];

    let sql = `
      SELECT
        t.rowid,
        t.file_path,
        t.session_id,
        t.turn_index,
        t.byte_offset,
        t.byte_length,
        t.timestamp,
        rank
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
      // Project dirs are encoded as --path-segments--
      sql += ` AND t.file_path LIKE ?`;
      params.push(`%${options.project}%`);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      rowid: number;
      file_path: string;
      session_id: string;
      turn_index: number;
      byte_offset: number;
      byte_length: number;
      timestamp: string;
      rank: number;
    }>;

    return rows.map(row => {
      // Retrieve the actual turn text via pread from the original file
      const text = this.readBytes(row.file_path, row.byte_offset, row.byte_length);

      const result: SearchResult = {
        sessionId: row.session_id,
        sessionFile: row.file_path,
        turnIndex: row.turn_index,
        timestamp: row.timestamp,
        score: row.rank,
        text: this.parseTurnText(text)
      };

      // Fetch surrounding turns for context
      if (contextTurns > 0) {
        result.context = this.getSurroundingTurns(
          row.file_path,
          row.turn_index,
          contextTurns
        );
      }

      return result;
    });
  }

  /**
   * Read raw bytes from a file at a specific offset. O(1).
   */
  readBytes(filePath: string, offset: number, length: number): string {
    try {
      const fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      closeSync(fd);
      return buffer.toString('utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Parse raw JSONL lines of a turn back into readable text.
   */
  parseTurnText(rawLines: string): string {
    const lines = rawLines.split('\n').filter(l => l.trim());
    const parts: string[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'message') continue;

        const role = obj.message?.role;
        const content = obj.message?.content;
        const text = this.extractText(content);

        if (text && role !== 'toolResult') {
          parts.push(`${role}: ${text}`);
        } else if (text && role === 'toolResult') {
          if (text.length > 300) {
            parts.push(`[tool result]: ${text.slice(0, 300)}...\n[Showing 300 of ${text.length} chars. Full output in source file above.]`);
          } else {
            parts.push(`[tool result]: ${text}`);
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Get ±N surrounding turns for context.
   */
  private getSurroundingTurns(
    filePath: string,
    turnIndex: number,
    range: number
  ): Turn[] {
    const minTurn = Math.max(0, turnIndex - range);
    const maxTurn = turnIndex + range;

    const rows = this.db.prepare(`
      SELECT rowid, file_path, session_id, turn_index, byte_offset, byte_length, timestamp
      FROM turn_offsets
      WHERE file_path = ?
        AND turn_index BETWEEN ? AND ?
        AND turn_index != ?
      ORDER BY turn_index
    `).all(filePath, minTurn, maxTurn, turnIndex) as Array<{
      rowid: number;
      file_path: string;
      session_id: string;
      turn_index: number;
      byte_offset: number;
      byte_length: number;
      timestamp: string;
    }>;

    return rows.map(row => ({
      sessionId: row.session_id,
      sessionFile: row.file_path,
      turnIndex: row.turn_index,
      timestamp: row.timestamp,
      byteOffset: row.byte_offset,
      byteLength: row.byte_length,
      text: this.parseTurnText(this.readBytes(row.file_path, row.byte_offset, row.byte_length))
    }));
  }

  /**
   * Remove all index entries for a file (used when file is rewritten/deleted).
   * With contentless_delete=1, we can properly remove FTS entries by rowid.
   */
  private removeFileEntries(filePath: string): void {
    const transaction = this.db.transaction(() => {
      // Get rowids to delete from FTS
      const rows = this.db.prepare(
        'SELECT rowid FROM turn_offsets WHERE file_path = ?'
      ).all(filePath) as Array<{ rowid: number }>;

      // Delete from FTS (contentless_delete=1 allows this)
      const deleteFts = this.db.prepare(
        'DELETE FROM sessions_fts WHERE rowid = ?'
      );
      for (const row of rows) {
        deleteFts.run(row.rowid);
      }

      this.db.prepare('DELETE FROM turn_offsets WHERE file_path = ?').run(filePath);
      this.db.prepare('DELETE FROM indexed_files WHERE path = ?').run(filePath);
    });

    transaction();
  }

  /**
   * Clean up entries for deleted session files.
   */
  async cleanup(): Promise<number> {
    const files = this.db.prepare('SELECT path FROM indexed_files').all() as Array<{ path: string }>;
    let removed = 0;

    for (const { path } of files) {
      try {
        await fs.access(path);
      } catch {
        this.removeFileEntries(path);
        removed++;
      }
    }

    return removed;
  }

  /**
   * List all project directories in sessions dir.
   */
  private async listProjectDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Get index statistics.
   */
  stats(): IndexStats {
    const files = this.db.prepare('SELECT COUNT(*) as count FROM indexed_files').get() as { count: number };
    const turns = this.db.prepare('SELECT COUNT(*) as count FROM turn_offsets').get() as { count: number };

    // Approximate index size
    let indexSize = 0;
    try {
      const pageCount = this.db.pragma('page_count') as Array<{ page_count: number }>;
      const pageSize = this.db.pragma('page_size') as Array<{ page_size: number }>;
      indexSize = (pageCount[0]?.page_count ?? 0) * (pageSize[0]?.page_size ?? 4096);
    } catch {}

    return {
      totalFiles: files.count,
      totalTurns: turns.count,
      indexSizeBytes: indexSize
    };
  }

  /**
   * Optimize FTS5 index (merge segments, reclaim space).
   * Call periodically, not on every reindex.
   */
  optimize(): void {
    this.db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('optimize')");
  }

  /**
   * Sanitize a query for FTS5.
   * - Empty/whitespace-only → returns empty string
   * - Strips bare FTS5 operators (AND, OR, NOT, NEAR) that aren't part of real terms
   * - Balances unclosed quotes
   * - Quotes terms containing special characters (hyphens, dots, etc.)
   */
  private sanitizeFtsQuery(query: string): string {
    if (!query || !query.trim()) return '';

    // FTS5 reserved operators — strip when they appear as standalone tokens
    const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

    const terms = query.split(/\s+/).filter(Boolean);
    const sanitized = terms
      .map(term => {
        // Strip standalone FTS5 operators
        if (FTS5_OPERATORS.has(term.toUpperCase()) && term === term.toUpperCase()) {
          return null;
        }

        // Strip bare parentheses/brackets
        const cleaned = term.replace(/^[()]+|[()]+$/g, '');
        if (!cleaned) return null;

        // If term contains FTS5 special chars, quote it
        if (/[\-:.@\/\\*()]/.test(cleaned)) {
          // Escape internal quotes
          const escaped = cleaned.replace(/"/g, '""');
          return `"${escaped}"`;
        }

        return cleaned;
      })
      .filter(Boolean)
      .join(' ');

    if (!sanitized) return '';

    // Balance unclosed quotes
    const quoteCount = (sanitized.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      return sanitized + '"';
    }

    return sanitized;
  }

  close(): void {
    this.db.close();
  }
}
