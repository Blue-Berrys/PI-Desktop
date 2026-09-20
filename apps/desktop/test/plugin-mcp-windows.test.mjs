import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";
import { resolveMcpNpmLaunch, windowsNpmCliLaunch } from "../electron/main/npm-cli-launch.ts";

const nativeWindows = process.platform === "win32";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-windows-")));
  const children = [];
  t.after(async () => {
    // Windows keeps running executable files locked until their process exits.
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture child did not exit")), 3_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, "portable Node & %literal%");
  const cwd = join(root, "server working directory");
  mkdirSync(bin);
  mkdirSync(cwd);
  const node = join(bin, "node.exe");
  if (nativeWindows) copyFileSync(process.execPath, node);
  else symlinkSync(process.execPath, node);
  const shim = join(bin, "npx.cmd");
  writeFileSync(shim, "@echo off\r\necho Unsafe shell shim executed >&2\r\nexit /b 99\r\n");
  const cli = join(bin, "node_modules", "npm", "bin", "npx-cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, `
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'literal-argv', version: '1' } });
  if (request.method === 'tools/list') send(request.id, { tools: [{ name: 'argv', inputSchema: { type: 'object' } }] });
  if (request.method === 'tools/call') send(request.id, { content: [{ type: 'text', text: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }) }] });
});
`);
  return { root, bin, cwd, node, shim, cli, spawn(...args) {
    const child = spawn(...args);
    children.push(child);
    return child;
  } };
}

function windowsPlatform(t) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
}

test("Windows MCP npx finds a portable Node installation and keeps argv literal without a shell", async (t) => {
  const f = fixture(t);
  windowsPlatform(t);
  const args = ["-y", "fixture-mcp", "a b", '"quotes"', "& echo injected", "%PATH%", "!bang!", "^caret", "semi;colon", "$(echo injected)"];
  const calls = [];
  const client = new McpServerClient({
    rootPath: f.cwd, commandPolicy: "trusted", server: { id: "fixture", transport: "stdio", command: "npx", args },
    values: { PATH: f.bin },
    spawnImpl(command, argv, options) {
      calls.push({ command, argv, options });
      return f.spawn(command, argv, options);
    },
  });
  t.after(() => client.close());
  await client.connect();
  const result = await client.callTool("argv", {});
  assert.deepEqual(JSON.parse(result.content[0].text), { args, cwd: f.cwd, path: f.bin });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, f.node);
  assert.deepEqual(calls[0].argv, [f.cli, ...args]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.PATH, f.bin);
});

test("Windows npx accepts an explicit trusted shim and bare .cmd name", (t) => {
  const f = fixture(t);
  windowsPlatform(t);
  for (const command of [f.shim, "npx.cmd", "NPX.CMD"]) {
    assert.deepEqual(resolveMcpNpmLaunch(command, { PATH: `"${f.bin}"` }), { command: f.node, args: [f.cli] });
  }
});

test("Windows global npm prefix finds Node only on the final child PATH", async (t) => {
  const f = fixture(t);
  windowsPlatform(t);
  const nodeBin = join(f.root, "separate Node installation");
  mkdirSync(nodeBin);
  const node = join(nodeBin, "node.exe");
  renameSync(f.node, node);
  const path = `${f.bin};${nodeBin}`;
  assert.deepEqual(resolveMcpNpmLaunch("npx", { Path: path }), { command: node, args: [f.cli] });
  const client = new McpServerClient({
    rootPath: f.cwd, commandPolicy: "trusted", server: { id: "fixture", transport: "stdio", command: "npx", args: ["literal&argument"] },
    values: { PATH: path }, spawnImpl: f.spawn,
  });
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(JSON.parse((await client.callTool("argv", {})).content[0].text).args, ["literal&argument"]);
  assert.throws(() => resolveMcpNpmLaunch("npx", { PATH: f.bin }), /required installation file is missing/);
});

test("Windows npm launcher mapping is shared with the selected executable path", (t) => {
  const f = fixture(t);
  windowsPlatform(t);
  const shim = join(f.bin, "npm.cmd");
  const cli = join(dirname(f.cli), "npm-cli.js");
  writeFileSync(shim, "@echo off\r\nexit /b 99\r\n");
  writeFileSync(cli, "process.stdout.write('10.0.0\\n')");
  const expected = { command: f.node, args: [cli] };
  assert.deepEqual(windowsNpmCliLaunch(shim, "npm"), expected);
  assert.deepEqual(resolveMcpNpmLaunch("npm", { PATH: f.bin }), expected);
});

test("missing shim, Node, or CLI never falls back to a shell or another installation", (t) => {
  windowsPlatform(t);
  for (const missing of ["shim", "node", "cli"]) {
    const f = fixture(t);
    rmSync(f[missing]);
    assert.throws(() => resolveMcpNpmLaunch(f.shim, { PATH: f.bin }), { code: "ENOENT" });
  }
});

test("native Windows executables and other commands keep direct execution and PATH precedence", (t) => {
  const f = fixture(t);
  windowsPlatform(t);
  const executable = join(f.bin, "npx.exe");
  writeFileSync(executable, "fixture native executable");
  assert.deepEqual(resolveMcpNpmLaunch("npx", { PATH: f.bin }), { command: executable, args: [] });
  for (const command of ["uvx", "custom.cmd", executable]) {
    assert.deepEqual(resolveMcpNpmLaunch(command, { PATH: f.bin }), { command, args: [] });
  }
  assert.deepEqual(resolveMcpNpmLaunch("npx", { PATH: f.cwd, Path: f.bin }), { command: "npx", args: [] });
});

test("POSIX npm and npx are not rewritten", (t) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", original));
  const f = fixture(t);
  for (const command of ["npm", "npx", f.shim]) {
    assert.deepEqual(resolveMcpNpmLaunch(command, { PATH: f.bin }), { command, args: [] });
  }
});
