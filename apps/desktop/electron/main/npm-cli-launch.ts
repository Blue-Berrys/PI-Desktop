import { accessSync, constants, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

type CommandLaunch = { command: string; args: string[] };

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** The installed npm layout used by both the executable picker and MCP. */
export function windowsNpmCliLaunch(
  shimPath: string,
  cli: "npm" | "npx",
  nodePath = join(dirname(shimPath), "node.exe"),
): CommandLaunch {
  const script = join(dirname(shimPath), "node_modules", "npm", "bin", `${cli}-cli.js`);
  for (const file of [shimPath, nodePath, script]) {
    if (!isAbsolute(file) || !isFile(file)) {
      throw Object.assign(new Error(`Cannot launch ${cli}: required installation file is missing: ${file}`), { code: "ENOENT" });
    }
    accessSync(file, constants.R_OK);
  }
  return { command: nodePath, args: [script] };
}

/** Match Node's case-insensitive Windows environment selection, including overrides. */
function lookupDirectories(env: Record<string, string>): string[] {
  const key = Object.keys(env).sort().find((key) => key.toLowerCase() === "path");
  return (key ? env[key] : "").split(";")
    .map((directory) => directory.replace(/^"(.*)"$/, "$1"))
    .filter((directory) => isAbsolute(directory));
}

/**
 * npm's Windows shims need cmd.exe, which would interpret literal MCP argv.
 * Resolve only the known npm distribution layout to Node + its CLI instead.
 * Other executables and platforms keep the existing direct-spawn behavior.
 */
export function resolveMcpNpmLaunch(command: string, env: Record<string, string>): CommandLaunch {
  const direct = { command, args: [] };
  if (process.platform !== "win32") return direct;
  const name = basename(command).toLowerCase();
  const match = /^(npm|npx)(?:\.(cmd|bat))?$/.exec(name);
  if (!match) return direct;
  const cli = match[1] as "npm" | "npx";
  const directories = lookupDirectories(env);
  let shim: string | undefined;
  if (isAbsolute(command)) {
    if (!match[2]) return direct;
    shim = command;
  } else if (!/[\\/]/.test(command)) {
    for (const directory of directories) {
      // A real native executable retains precedence over npm's script shims.
      const extensions = match[2] ? [`.${match[2]}`] : [".com", ".exe", ".cmd", ".bat"];
      const found = extensions.map((extension) => join(directory, `${cli}${extension}`)).find(isFile);
      if (!found) continue;
      if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args: [] };
      shim = found;
      break;
    }
  }
  if (!shim) return direct;
  const localNode = join(dirname(shim), "node.exe");
  const node = isFile(localNode) ? localNode : directories.map((directory) => join(directory, "node.exe")).find(isFile);
  return windowsNpmCliLaunch(shim, cli, node ?? localNode);
}
