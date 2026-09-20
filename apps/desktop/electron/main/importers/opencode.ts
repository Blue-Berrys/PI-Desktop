import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExternalSessionSummary,
  ImportedSession,
  ImportedUiMessage,
  SessionImporter,
} from "./types";
import { importedSessionId, toIso, truncateTitle } from "./types";
import { readOpenCodeDatabase, scanOpenCodeDatabase } from "./opencode-sqlite";

export function openCodeDataDir(home = os.homedir(), env = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share"), "opencode");
}

/** IDs become paths only for the legacy JSON store. Reject both OS separators. */
export function isOpenCodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

interface OpenCodeSession {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  time?: { created?: number; updated?: number };
}

export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  time?: { created?: number; completed?: number };
}

export interface OpenCodePart {
  id: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: { input?: unknown; output?: unknown; error?: string; status?: string };
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function loadMessages(storageDir: string, sessionId: string): Promise<OpenCodeMessage[]> {
  const dir = path.join(storageDir, "message", sessionId);
  const out: OpenCodeMessage[] = [];
  for (const file of await listJsonFiles(dir)) {
    const msg = await readJson<OpenCodeMessage>(path.join(dir, file));
    if (msg && isOpenCodeId(msg.id) && (!msg.sessionID || msg.sessionID === sessionId)) out.push(msg);
  }
  out.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return out;
}

export function createOpenCodeImporter(dataDir = openCodeDataDir()): SessionImporter {
  const storageDir = path.join(dataDir, "storage");
  const databasePath = path.join(dataDir, "opencode.db");
  return {
    source: "opencode",

    async scan(): Promise<ExternalSessionSummary[]> {
      const databaseSessions = await scanOpenCodeDatabase(databasePath);
      const sessionRoot = path.join(storageDir, "session");
      let projectDirs: string[] = [];
      try {
        projectDirs = await fs.readdir(sessionRoot);
      } catch {
        return databaseSessions;
      }
      const summaries: ExternalSessionSummary[] = [];
      for (const dir of projectDirs) {
        const dirPath = path.join(sessionRoot, dir);
        let stat;
        try {
          stat = await fs.stat(dirPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        for (const file of await listJsonFiles(dirPath)) {
          const session = await readJson<OpenCodeSession>(path.join(dirPath, file));
          if (!session || !isOpenCodeId(session.id)) continue;
          let messageCount = 0;
          try {
            messageCount = (
              await fs.readdir(path.join(storageDir, "message", session.id))
            ).filter((f) => f.endsWith(".json")).length;
          } catch {
            continue;
          }
          if (messageCount === 0) continue;
          summaries.push({
            source: "opencode",
            externalId: session.id,
            title: truncateTitle(session.title ?? "") || session.id,
            projectPath: session.directory ?? null,
            model: null,
            createdAt: toIso(session.time?.created),
            updatedAt: toIso(session.time?.updated, toIso(session.time?.created)),
            messageCount,
            filePath: path.join(dirPath, file),
          });
        }
      }
      // Migrated JSON files can remain on disk. The current DB copy wins.
      const merged = new Map(summaries.map((item) => [item.externalId, item]));
      for (const item of databaseSessions) merged.set(item.externalId, item);
      return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.externalId.localeCompare(b.externalId));
    },

    async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
      if (!isOpenCodeId(summary.externalId)) throw new Error("Invalid OpenCode session ID");
      const databaseMessages = summary.filePath === databasePath
        ? readOpenCodeDatabase(databasePath, summary.externalId)
        : undefined;
      const ocMessages: Array<{ info: OpenCodeMessage; parts?: OpenCodePart[] }> = databaseMessages ?? (await loadMessages(storageDir, summary.externalId)).map((info) => ({ info }));
      const messages: ImportedUiMessage[] = [];
      let modelId: string | null = null;
      let providerId: string | null = null;

      for (const entry of ocMessages) {
        const msg = entry.info;
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        if (msg.role === "assistant") {
          modelId = msg.modelID ?? modelId;
          providerId = msg.providerID ?? providerId;
        }
        const createdAt = toIso(msg.time?.created);
        const partDir = path.join(storageDir, "part", msg.id);
        const texts: string[] = [];
        const toolMessages: ImportedUiMessage[] = [];
        const parts = entry.parts ?? await Promise.all(
          (await listJsonFiles(partDir)).map((file) => readJson<OpenCodePart>(path.join(partDir, file))),
        );
        for (const part of parts) {
          if (!part) continue;
          if (part.type === "text" && part.text && part.synthetic !== true) {
            texts.push(part.text);
          } else if (part.type === "tool") {
            const output = part.state?.status === "error" ? part.state.error ?? part.state.output : part.state?.output;
            const outputText =
              typeof output === "string" ? output : output ? JSON.stringify(output) : "";
            toolMessages.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: outputText,
              createdAt,
              toolName: part.tool,
              toolCallId: part.callID,
              toolStatus: part.state?.status === "error" ? "error" : "success",
              toolArgs: part.state?.input,
              toolResult: outputText,
              isError: part.state?.status === "error" || undefined,
              status: "complete",
            });
          }
        }
        const text = texts.join("\n").trim();
        if (text) {
          messages.push({
            id: crypto.randomUUID(),
            role: msg.role === "user" ? "user" : "assistant",
            content: text,
            createdAt,
            status: msg.role === "assistant" ? "complete" : undefined,
          });
        }
        messages.push(...toolMessages);
      }

      return {
        session: {
          id: importedSessionId("opencode", summary.externalId),
          title: summary.title,
          projectPath: summary.projectPath,
          modelId,
          providerId,
          mode: "agent",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        },
        messages,
      };
    },
  };
}

export const opencodeImporter = createOpenCodeImporter();
