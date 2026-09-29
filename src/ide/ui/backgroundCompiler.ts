import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

import { resolvePBinary } from "../../miscTools";
import { Messages } from "./messages";
import { PDiagnostic, parsePDiagnostics } from "./pDiagnostics";

// Runs `p compile` in the background and reports the result as editor
// diagnostics and a status bar item, instead of in a terminal. The full
// compiler output goes to the "P Compiler" output channel, which the status
// bar item opens.
//
// At most one compile runs at a time: a new request cancels the running one
// and starts over, so only the latest sources are ever reported.
export default class BackgroundCompiler implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("P Compiler");
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("p");
  private readonly status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );
  private running: ChildProcess | undefined;
  private generation = 0;

  constructor(showOutputCommand: string) {
    this.status.name = "P Compiler";
    this.status.command = showOutputCommand;
    this.setStatus("$(question) P", "P: not compiled yet");
    this.status.show();
  }

  showOutput(): void {
    this.output.show(true);
  }

  async compile(cwd: string): Promise<void> {
    const generation = ++this.generation;
    this.cancel();

    const binary = await resolvePBinary();
    if (generation !== this.generation) {
      return;
    }
    if (!binary) {
      this.setStatus("$(warning) P", Messages.Installation.noP);
      this.output.appendLine(Messages.Installation.noP);
      return;
    }

    const project = path.basename(cwd);
    this.setStatus("$(sync~spin) P", `P: compiling ${project}…`);
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] p compile (${cwd})`);

    let text = "";
    const child = spawn(binary, ["compile"], { cwd });
    this.running = child;
    const append = (chunk: Buffer) => {
      const s = chunk.toString();
      text += s;
      this.output.append(s);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        this.output.appendLine(String(err));
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });
    if (generation !== this.generation) {
      return;
    }
    this.running = undefined;

    const found = parsePDiagnostics(text);
    await this.publish(found, cwd);
    if (generation !== this.generation) {
      return;
    }

    if (found.length > 0) {
      const summary = `${found.length} error${found.length === 1 ? "" : "s"}`;
      this.setStatus(`$(error) P ${found.length}`, `P: ${summary} in ${project}`);
    } else if (exitCode !== 0) {
      this.setStatus("$(error) P", `P: compiling ${project} failed, click for details`);
    } else {
      this.setStatus("$(check) P", `P: ${project} compiled`);
    }
  }

  dispose(): void {
    this.generation++;
    this.cancel();
    this.output.dispose();
    this.diagnostics.dispose();
    this.status.dispose();
  }

  private cancel(): void {
    if (this.running) {
      this.running.kill();
      this.running = undefined;
      this.output.appendLine("(cancelled)");
    }
  }

  private setStatus(text: string, tooltip: string): void {
    this.status.text = text;
    this.status.tooltip = tooltip;
  }

  private async publish(found: PDiagnostic[], cwd: string): Promise<void> {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of found) {
      const uri = await resolveFile(d, cwd);
      const range = await wordRangeAt(uri, new vscode.Position(d.line, d.character));
      const diagnostic = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = "p";
      const key = uri.toString();
      byFile.set(key, [...(byFile.get(key) ?? []), diagnostic]);
    }
    this.diagnostics.clear();
    for (const [uri, list] of byFile) {
      this.diagnostics.set(vscode.Uri.parse(uri), list);
    }
  }
}

// Type errors carry a path relative to the compile's working directory, which
// may point into an included project (`../Other/PSrc/A.p`). Parse errors only
// name the file, so look it up, preferring the project being compiled.
async function resolveFile(d: PDiagnostic, cwd: string): Promise<vscode.Uri> {
  if (d.kind === "type") {
    return vscode.Uri.file(path.resolve(cwd, d.file));
  }
  const matches = await vscode.workspace.findFiles(`**/${d.file}`);
  const inProject = matches.find((m) => m.fsPath.startsWith(cwd + path.sep));
  return inProject ?? matches[0] ?? vscode.Uri.file(path.join(cwd, d.file));
}

// Underline the whole token rather than a single character.
async function wordRangeAt(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Range> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const range = document.getWordRangeAtPosition(position);
    if (range) {
      return range;
    }
  } catch {
    // Fall through to a single-character range.
  }
  return new vscode.Range(position, position.translate(0, 1));
}
