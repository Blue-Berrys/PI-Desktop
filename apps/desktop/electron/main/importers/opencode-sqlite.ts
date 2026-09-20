import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { OpenCodeMessage, OpenCodePart } from "./opencode";
import type { ExternalSessionSummary } from "./types";
import { toIso, truncateTitle } from "./types";

// OpenCode v1.18.26, commit 774cc7c: core/src/session/sql.ts and
// opencode/src/session/message-v2.ts. These columns also cover the initial
// SQLite migration. The separate session_message projection belongs to v2.
const PAGE_SIZE = 256;
type Row = Record<string, unknown>;
type MessageWithParts = { info: OpenCodeMessage; parts: OpenCodePart[] };

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid OpenCode text field");
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid OpenCode timestamp");
  return value;
}

function object(value: unknown): Row {
  let parsed: unknown;
  try { parsed = JSON.parse(text(value)); }
  catch { throw new Error("Invalid OpenCode JSON data"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid OpenCode data");
  return parsed as Row;
}

function readSnapshot<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    // Bound contention with an active OpenCode writer; never migrate, recover,
    // checkpoint, or copy the external database (a live WAL may hold its tail).
    db.exec("PRAGMA busy_timeout = 250; PRAGMA trusted_schema = OFF; BEGIN");
    return read(db);
  } finally {
    db.close();
  }
}

export async function scanOpenCodeDatabase(file: string): Promise<ExternalSessionSummary[]> {
  if (!existsSync(file)) return [];
  try {
    return readSnapshot(file, (db) => {
      // Reject incomplete/foreign schemas before giving their rows priority
      // over surviving JSON copies.
      db.prepare("SELECT id, message_id, session_id, data FROM part LIMIT 0");
      const page = db.prepare(`SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
        (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
        FROM session s WHERE s.id > ? ORDER BY s.id LIMIT ?`);
      const summaries: ExternalSessionSummary[] = [];
      let cursor = "";
      for (;;) {
        const rows = page.all(cursor, PAGE_SIZE);
        for (const row of rows) {
          const id = text(row.id);
          if (!/^[A-Za-z0-9_-]+$/.test(id) || Number(row.message_count) === 0) continue;
          summaries.push({
            source: "opencode", externalId: id,
            title: truncateTitle(text(row.title)) || id,
            projectPath: text(row.directory) || null,
            model: null, createdAt: toIso(timestamp(row.time_created)),
            updatedAt: toIso(timestamp(row.time_updated)),
            messageCount: Number(row.message_count), filePath: file,
          });
        }
        if (rows.length < PAGE_SIZE) break;
        cursor = text(rows[rows.length - 1].id);
      }
      return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.externalId.localeCompare(b.externalId));
    });
  } catch {
    // A broken/locked/newer database must not hide legacy JSON candidates.
    // Never log SQL data, session content, or source paths.
    console.warn("[session.import] OpenCode SQLite scan failed; legacy JSON scan remains available");
    return [];
  }
}

export function readOpenCodeDatabase(file: string, sessionId: string): MessageWithParts[] {
  return readSnapshot(file, (db) => {
    if (!db.prepare("SELECT id FROM session WHERE id = ?").get(sessionId)) {
      throw new Error("OpenCode session no longer exists");
    }
    const messages = db.prepare(`SELECT id, time_created, data FROM message
      WHERE session_id = ? AND (time_created > ? OR (time_created = ? AND id > ?))
      ORDER BY time_created, id LIMIT ?`);
    const parts = db.prepare(`SELECT id, data FROM part
      WHERE session_id = ? AND message_id = ? ORDER BY id`);
    const result: MessageWithParts[] = [];
    let time = Number.MIN_SAFE_INTEGER;
    let id = "";
    for (;;) {
      const rows = messages.all(sessionId, time, time, id, PAGE_SIZE);
      for (const row of rows) {
        const data = object(row.data);
        if (data.role !== "user" && data.role !== "assistant") throw new Error("Invalid OpenCode message role");
        const messageId = text(row.id);
        const hydrated = parts.all(sessionId, messageId).map((part) => {
          const value = object(part.data);
          if (typeof value.type !== "string") throw new Error("Invalid OpenCode part type");
          if (value.type === "text" && typeof value.text !== "string") throw new Error("Invalid OpenCode text part");
          if (value.type === "tool" && (!value.state || typeof value.state !== "object" || Array.isArray(value.state))) {
            throw new Error("Invalid OpenCode tool part");
          }
          if (value.type === "tool" && (typeof value.tool !== "string" || typeof value.callID !== "string")) {
            throw new Error("Invalid OpenCode tool identity");
          }
          return { ...value, id: text(part.id) } as OpenCodePart;
        });
        result.push({
          info: {
            id: messageId, sessionID: sessionId, role: data.role,
            modelID: typeof data.modelID === "string" ? data.modelID : undefined,
            providerID: typeof data.providerID === "string" ? data.providerID : undefined,
            time: { created: timestamp(row.time_created) },
          },
          parts: hydrated,
        });
      }
      if (rows.length < PAGE_SIZE) break;
      const last = rows[rows.length - 1];
      time = timestamp(last.time_created);
      id = text(last.id);
    }
    return result;
  });
}
