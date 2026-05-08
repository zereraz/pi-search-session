/**
 * pi-session-search extension
 * Registers search_sessions and reindex_sessions tools
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { SessionIndex } from "./session-index.js";
import { join } from "path";
import { homedir } from "os";

const HOME = process.env.HOME || homedir();
const INDEX_DB = join(HOME, ".pi", "agent", "session-index.db");
const SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");

/** Resolve time_range shorthand to ISO timestamp */
function resolveTimeRange(range: string): string {
  const now = Date.now();
  switch (range) {
    case 'day': return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case 'week': return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'month': return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'year': return new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
    default:
      // Treat as ISO date string (e.g. "2026-05-01")
      return new Date(range).toISOString();
  }
}

export default function (pi: ExtensionAPI) {
  let sessionIndex: SessionIndex | null = null;

  async function getSessionIndex() {
    if (!sessionIndex) {
      sessionIndex = new SessionIndex(INDEX_DB, SESSIONS_DIR);
      await sessionIndex.reindex();
    }
    return sessionIndex;
  }

  pi.registerTool({
    name: "search_sessions",
    label: "Search Sessions",
    description:
      "Search across all past pi sessions using full-text search. Returns BM25-ranked results with context.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: "Search query (natural language or keywords). Required unless pattern is provided.",
      })),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default: 5)" })
      ),
      project: Type.Optional(
        Type.String({ description: "Filter by project name" })
      ),
      session_id: Type.Optional(
        Type.String({ description: "Filter to a specific session by ID" })
      ),
      time_range: Type.Optional(
        Type.String({ description: "Filter by time: 'day', 'week', 'month', 'year', or ISO date like '2026-05-01'" })
      ),
      pattern: Type.Optional(
        Type.String({ description: "Regex pattern to filter results (applied after FTS5 search)" })
      ),
      context_turns: Type.Optional(
        Type.Number({
          description: "Surrounding turns for context (default: 1)",
        })
      ),
    }),
    execute: async (_toolCallId: string, params: any) => {
      try {
        const idx = await getSessionIndex();
        await idx.reindex();

        const searchOpts = {
          limit: params.limit ?? 5,
          project: params.project,
          sessionId: params.session_id,
          after: params.time_range ? resolveTimeRange(params.time_range) : undefined,
        };

        let results;
        if (params.pattern && !params.query) {
          // Pure regex search (no FTS5)
          results = idx.searchRegex(params.pattern, searchOpts);
        } else {
          // FTS5 search, optionally post-filtered by regex
          results = idx.search(params.query, { ...searchOpts, contextTurns: params.context_turns ?? 1 });
          if (params.pattern && results.length > 0) {
            try {
              const re = new RegExp(params.pattern, 'i');
              results = results.filter((r: any) => re.test(r.text));
            } catch {}
          }
        }

        if (results.length === 0) {
          const filters = [params.project && `project: ${params.project}`, params.session_id && `session: ${params.session_id}`, params.time_range && `time: ${params.time_range}`, params.pattern && `pattern: /${params.pattern}/`].filter(Boolean).join(' | ');
          const queryStr = params.query || params.pattern || '';
          return {
            content: [{ type: "text" as const, text: `Query: ${queryStr}${filters ? ` (${filters})` : ""}\nNo results found.` }],
          };
        }

        const filters = [params.project && `project: ${params.project}`, params.session_id && `session: ${params.session_id?.slice(0,8)}`, params.time_range && `time: ${params.time_range}`, params.pattern && `pattern: /${params.pattern}/`].filter(Boolean).join(' | ');
        let output = `Query: ${params.query || params.pattern}${filters ? ` | ${filters}` : ""} | ${results.length} results\n\n`;
        output += results
          .map((r: any, i: number) => {
            let entry = `## Result ${i + 1} (score: ${r.score.toFixed(2)})\n`;
            entry += `Session: ${r.sessionId} | Turn: ${r.turnIndex}\n`;
            entry += `File: ${r.sessionFile}\n\n`;
            entry += r.text;
            if (r.context?.length) {
              entry += `\n\n<context>\n${r.context.map((c: any) => c.text).join("\n---\n")}\n</context>`;
            }
            return entry;
          })
          .join("\n\n---\n\n");

        return { content: [{ type: "text" as const, text: output }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        };
      }
    },
  });

  pi.registerTool({
    name: "reindex_sessions",
    label: "Reindex Sessions",
    description:
      "Rebuild the session search index (only indexes new content, usually fast).",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const idx = await getSessionIndex();
        await idx.reindex();
        const stats = idx.stats();
        return {
          content: [
            {
              type: "text" as const,
              text: `✓ Reindexed. ${stats.totalFiles} files, ${stats.totalTurns} turns, ${(stats.indexSizeBytes / 1024).toFixed(0)}KB index.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        };
      }
    },
  });
}
