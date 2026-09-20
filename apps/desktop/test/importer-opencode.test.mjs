import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// Use an isolated source root; never open the developer's OpenCode history.
const home = await mkdtemp(join(tmpdir(), "pi-opencode-import-"));
const { createOpenCodeImporter, openCodeDataDir } = await import("../electron/main/importers/opencode.ts");

// OpenCode v1.18.26 (774cc7c): packages/core/src/session/sql.ts and
// packages/opencode/src/session/message-v2.ts. Message/part JSON omits the
// relational IDs; message order is (time_created, id), part order is id.
function database(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT,
      slug TEXT, directory TEXT, title TEXT, version TEXT,
      time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    CREATE INDEX part_message_id_id_idx ON part(message_id,id);
  `);
  return db;
}

test("production scan and convert detect a DB-only OpenCode v1 session", async () => {
  try {
    const dir = join(home, ".local", "share", "opencode");
    await mkdir(dir, { recursive: true });
    const db = database(join(dir, "opencode.db"));
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ses_fixture", "project", null, "fixture", "/fixture/project", "SQLite session", "1.18.26", 1000, 2000);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
      .run("msg_fixture", "ses_fixture", 1100, 1100, JSON.stringify({ role: "user", time: { created: 1100 } }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run("prt_fixture", "msg_fixture", "ses_fixture", 1100, 1100, JSON.stringify({ type: "text", text: "Hello from SQLite" }));
    db.close();
    const importer = createOpenCodeImporter(dir);
    const sessions = await importer.scan();
    assert.equal(sessions.length, 1, "DB-only sessions must be discoverable");
    const imported = await importer.convert(sessions[0]);
    assert.equal(imported.session.id, "import-opencode-ses_fixture");
    assert.equal(imported.messages[0].content, "Hello from SQLite");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-opencode-fixture-"));
  try { await run(dir, createOpenCodeImporter(dir)); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function session(db, id, updated = 2000) {
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, "project", null, "fixture", "C:/fixture/project", `DB ${id}`, "1.18.26", 1000, updated);
}

function message(db, sessionId, id, created, role, parts, extra = {}) {
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run(id, sessionId, created, created, JSON.stringify({ role, time: { created }, ...extra }));
  const statement = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  for (const [partId, data] of parts) statement.run(partId, id, sessionId, created, created, JSON.stringify(data));
}

async function legacy(dir, id, title = "Legacy session") {
  for (const subdir of ["session/project", `message/${id}`, `part/msg_${id}`]) {
    await mkdir(join(dir, "storage", subdir), { recursive: true });
  }
  await writeFile(join(dir, "storage", "session/project", `${id}.json`), JSON.stringify({ id, title, directory: "/legacy", time: { created: 100, updated: 500 } }));
  await writeFile(join(dir, "storage/message", id, "message.json"), JSON.stringify({ id: `msg_${id}`, sessionID: id, role: "user", time: { created: 200 } }));
  await writeFile(join(dir, "storage/part", `msg_${id}`, "part.json"), JSON.stringify({ id: "prt_legacy", type: "text", text: "Legacy text" }));
}

test("resolves the default and absolute XDG data roots without a cwd-relative override", () => {
  assert.equal(openCodeDataDir("/fixture", {}), join("/fixture", ".local/share/opencode"));
  assert.equal(openCodeDataDir("/fixture", { XDG_DATA_HOME: "/xdg" }), join("/xdg", "opencode"));
  assert.equal(openCodeDataDir("/fixture", { XDG_DATA_HOME: "relative" }), join("/fixture", ".local/share/opencode"));
});

test("production factory discovers the store under XDG_DATA_HOME", async () => {
  await fixture(async (dir) => {
    const data = join(dir, "opencode");
    await mkdir(data);
    await legacy(data, "ses_xdg");
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    try {
      const importer = createOpenCodeImporter();
      const [found] = await importer.scan();
      assert.equal(found.externalId, "ses_xdg");
      assert.equal((await importer.convert(found)).messages[0].content, "Legacy text");
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  });
});

test("SQLite and JSON coexist, deduplicate by session ID and retain legacy conversion", async () => {
  await fixture(async (dir, importer) => {
    await legacy(dir, "ses_shared", "Old copy");
    await legacy(dir, "ses_legacy");
    const file = join(dir, "opencode.db");
    const db = database(file);
    session(db, "ses_shared");
    message(db, "ses_shared", "msg_shared", 1200, "user", [["part_shared", { type: "text", text: "Current DB text" }]]);
    session(db, "ses_empty");
    db.close();
    const before = await readFile(file);
    const found = await importer.scan();
    assert.deepEqual(found.map((s) => s.externalId), ["ses_shared", "ses_legacy"]);
    assert.equal(found[0].title, "DB ses_shared");
    assert.equal(found[0].projectPath, "C:/fixture/project");
    assert.equal((await importer.convert(found[0])).messages[0].content, "Current DB text");
    assert.equal((await importer.convert(found[1])).messages[0].content, "Legacy text");
    assert.deepEqual(await readFile(file), before, "source DB bytes must not change");
  });
});

test("reads every page with tied timestamps and ID-ordered text/tool parts", async () => {
  await fixture(async (dir, importer) => {
    const db = database(join(dir, "opencode.db"));
    session(db, "ses_history");
    // >2 pages; reverse insertion and a shared timestamp rule out rowid ordering
    // or a time-only cursor that would lose the second page.
    for (let index = 519; index >= 0; index--) {
      const id = `msg_${String(index).padStart(4, "0")}`;
      message(db, "ses_history", id, 1200, "user", [[`prt_${id}`, { type: "text", text: String(index) }]]);
    }
    message(db, "ses_history", "msg_final", 1300, "assistant", [
      ["prt_z", { type: "tool", tool: "Read", callID: "call_error", state: { status: "error", input: { path: "b" }, error: "Fixture failure" } }],
      ["prt_c", { type: "text", text: "second" }],
      ["prt_b", { type: "text", text: "synthetic", synthetic: true }],
      ["prt_a", { type: "text", text: "first" }],
      ["prt_y", { type: "tool", tool: "Read", callID: "call_ok", state: { status: "completed", input: { path: "a" }, output: "Read result" } }],
      ["prt_d", { type: "reasoning", text: "private reasoning" }],
    ], { modelID: "fixture-model", providerID: "fixture-provider" });
    // Another session's part must not leak even if its message_id is forged.
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("prt_foreign", "msg_final", "ses_foreign", 1300, 1300, JSON.stringify({ type: "text", text: "foreign" }));
    db.close();
    const [found] = await importer.scan();
    assert.equal(found.messageCount, 521);
    const result = await importer.convert(found);
    assert.equal(result.messages.length, 523);
    assert.deepEqual(result.messages.slice(0, 520).map((m) => m.content), Array.from({ length: 520 }, (_, n) => String(n)));
    assert.equal(result.messages[520].role, "assistant");
    assert.equal(result.messages[520].content, "first\nsecond");
    assert.deepEqual(result.messages.slice(521).map((m) => [m.toolCallId, m.toolStatus, m.content]), [["call_ok", "success", "Read result"], ["call_error", "error", "Fixture failure"]]);
    assert.deepEqual(result.messages[521].toolArgs, { path: "a" });
    assert.equal(result.messages[522].isError, true);
    assert.equal(result.session.modelId, "fixture-model");
    assert.equal(result.session.providerId, "fixture-provider");
  });
});

test("session scanning spans all pages rather than silently truncating an archive", async () => {
  await fixture(async (dir, importer) => {
    const db = database(join(dir, "opencode.db"));
    for (let n = 0; n < 260; n++) {
      const id = `ses_${String(n).padStart(4, "0")}`;
      session(db, id);
      message(db, id, `msg_${id}`, 1200, "user", []);
    }
    db.close();
    assert.equal((await importer.scan()).length, 260);
  });
});

for (const problem of ["missing", "corrupt", "unsupported", "missing-parts", "locked"]) {
  test(`${problem} SQLite does not block old JSON discovery`, async () => {
    await fixture(async (dir, importer) => {
      await legacy(dir, "ses_legacy");
      const file = join(dir, "opencode.db");
      let db;
      if (problem === "corrupt") await writeFile(file, "not a SQLite database");
      if (problem === "unsupported") { db = new DatabaseSync(file); db.exec("CREATE TABLE unrelated (value TEXT)"); }
      if (problem === "missing-parts") { db = database(file); session(db, "ses_legacy"); db.exec("DROP TABLE part"); }
      if (problem === "locked") { db = database(file); db.exec("BEGIN EXCLUSIVE"); }
      try {
        const found = await importer.scan();
        assert.deepEqual(found.map((s) => s.externalId), ["ses_legacy"]);
        assert.equal((await importer.convert(found[0])).messages[0].content, "Legacy text");
      } finally { db?.close(); }
    });
  });
}

test("reads committed WAL data without checkpointing or importing an uncommitted write", async () => {
  await fixture(async (dir, importer) => {
    const file = join(dir, "opencode.db");
    const db = database(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      session(db, "ses_wal");
      message(db, "ses_wal", "msg_wal", 1200, "user", [["prt_wal", { type: "text", text: "Committed WAL text" }]]);
      const before = await readFile(file);
      const wal = await readFile(`${file}-wal`);
      db.exec("BEGIN IMMEDIATE");
      session(db, "ses_pending");
      const found = await importer.scan();
      assert.deepEqual(found.map((s) => s.externalId), ["ses_wal"]);
      assert.equal((await importer.convert(found[0])).messages[0].content, "Committed WAL text");
      assert.deepEqual(await readFile(file), before);
      assert.deepEqual(await readFile(`${file}-wal`), wal);
    } finally { db.close(); }
  });
});

test("a changed or malformed selected DB fails conversion without importing a partial transcript", async () => {
  await fixture(async (dir, importer) => {
    const file = join(dir, "opencode.db");
    const db = database(file);
    session(db, "ses_corrupt");
    message(db, "ses_corrupt", "msg_good", 1200, "user", [["prt_good", { type: "text", text: "good" }]]);
    const [found] = await importer.scan();
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg_bad", "ses_corrupt", 1300, 1300, "not json");
    await assert.rejects(importer.convert(found));
    db.exec("DELETE FROM session");
    await assert.rejects(importer.convert(found), /no longer exists/);
    db.close();
    await assert.rejects(importer.convert({ ...found, externalId: "../outside" }), /Invalid OpenCode session ID/);
    await assert.rejects(importer.convert({ ...found, externalId: "..\\outside" }), /Invalid OpenCode session ID/);
  });
});
