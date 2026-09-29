import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import which = require("which");

import { ConfigurationConstants } from "./constants";

// Searches the current workspace for files matching a glob pattern and returns
// the matching URIs. Honours the user's `p-vscode.pcompile.exclude` setting.
export async function searchDirectory(pattern: string) {
  if (vscode.workspace.workspaceFolders === undefined) {
    return null;
  }
  const folder = vscode.workspace.workspaceFolders[0].uri;
  pattern = pattern.replace(folder.fsPath, "");
  const filePattern = new vscode.RelativePattern(folder.fsPath, pattern);

  const excludeFolders: Array<string> =
    vscode.workspace
      .getConfiguration(ConfigurationConstants.SectionName)
      .get<string[]>(ConfigurationConstants.Compile.Exclude) ?? [
      "**/Build/*",
      "**/build/**",
    ];
  const excludeFilePattern =
    excludeFolders.length > 1
      ? "{" + excludeFolders.join(",") + "}"
      : excludeFolders.join("");

  return await vscode.workspace.findFiles(filePattern, excludeFilePattern);
}

// Check if `p` is installed by resolving it on PATH. Works the same on Linux,
// macOS and Windows without going through a user shell.
export async function checkPInstalled(): Promise<boolean> {
  try {
    await which("p");
    return true;
  } catch {
    return false;
  }
}

// Convenience: resolve the absolute path to the `p` binary, or undefined.
export async function resolvePBinary(): Promise<string | undefined> {
  try {
    return await which("p");
  } catch {
    return undefined;
  }
}

// Re-export `path.join` style helpers if downstream callers want them.
export const joinPath = path.join;

// Returns the installed P compiler's [major, minor] version, or undefined if
// it cannot be determined. `p --version` exits non-zero even on success, so
// the output is parsed regardless of the exit code.
export async function getPVersion(): Promise<[number, number] | undefined> {
  const binary = await resolvePBinary();
  if (!binary) {
    return undefined;
  }
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10000 }, (_err, stdout, stderr) => {
      const match = /P version (\d+)\.(\d+)/.exec(`${stdout}${stderr}`);
      resolve(match ? [Number(match[1]), Number(match[2])] : undefined);
    });
  });
}
