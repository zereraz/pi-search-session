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
      query: Type.String({
        description: "Search query (natural language or keywords)",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default: 5)" })
      ),
      project: Type.Optional(
        Type.String({ description: "Filter by project name" })
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
        const results = idx.search(params.query, {
          limit: params.limit ?? 5,
          contextTurns: params.context_turns ?? 1,
          project: params.project,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
          };
        }

        const output = results
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
