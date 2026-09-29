import * as path from "path";
import * as vscode from "vscode";
import * as messages from "./messages";

import { ConfigurationConstants } from "../../constants";
import { resolvePBinary, searchDirectory } from "../../miscTools";
import { PCommands } from "../../commands";
import BackgroundCompiler from "./backgroundCompiler";
import { PProject, affectedProjectDirs } from "./pProjects";
import TestingEditor from "./testinginEditor";

// Compiles the active P project in the background on save and on request.
// The `p-vscode: Compile` task is still provided for tasks.json and Run Task.
export default class CompileCommands {
  // Directory of the active P project; compiles run here.
  static currCwd = "";
  // All discovered P projects (one quick-pick entry per .pproj).
  static projects: vscode.QuickPickItem[] = [];
  static options: vscode.QuickPickOptions = {
    title: "Choose the project to compile...",
    canPickMany: false,
    onDidSelectItem: changeCompilationCommand,
  };

  public static async createAndRegister(
    context: vscode.ExtensionContext
  ): Promise<CompileCommands> {
    await generateProjects();
    createCompileTask();
    compiler = new BackgroundCompiler(showCompilerOutputCommand);

    // Watching the file system rather than editor saves also picks up
    // changes made outside the editor, such as a git checkout.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{p,pproj}");
    const onChange = (uri: vscode.Uri) => scheduleCompile(uri.fsPath);
    const onCreateOrDelete = async (uri: vscode.Uri) => {
      if (uri.fsPath.endsWith(".pproj")) {
        await generateProjects();
      }
      scheduleCompile(uri.fsPath);
    };

    context.subscriptions.push(
      compiler,
      vscode.commands.registerCommand("peasy.showProjectFiles", () => showFiles()),
      vscode.commands.registerCommand("peasy.compile", () => compile(activeFile())),
      vscode.commands.registerCommand(showCompilerOutputCommand, () =>
        compiler?.showOutput()
      ),
      watcher,
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onCreateOrDelete),
      watcher.onDidDelete(onCreateOrDelete),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.uri.scheme === "file") {
          void compileIfStale(editor.document.uri.fsPath);
        }
      }),
      {
        dispose: () => clearTimeout(changeDebounce),
      }
    );

    // VS Code restores open editors before activation; treat the active one
    // as just opened.
    const [file] = activeFile();
    if (file) {
      await compileIfStale(file);
    }
    return new CompileCommands();
  }
}

const showCompilerOutputCommand = "peasy.showCompilerOutput";
let compiler: BackgroundCompiler | undefined;
let changeDebounce: NodeJS.Timeout | undefined;
let changedFiles: string[] = [];
let pendingMarks: Promise<void>[] = [];

interface CompileSettings {
  onChange: boolean;
  onOpen: boolean;
  includingProjects: boolean;
}

// Read on every use, so changes apply without reloading.
function compileSettings(): CompileSettings {
  const config = vscode.workspace.getConfiguration(ConfigurationConstants.SectionName);
  const keys = ConfigurationConstants.Compile;
  return {
    onChange: config.get<boolean>(keys.OnChange, true),
    onOpen: config.get<boolean>(keys.OnOpen, true),
    includingProjects: config.get<boolean>(keys.IncludingProjects, true),
  };
}

function activeFile(): string[] {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? [uri.fsPath] : [];
}

// Compiles every project affected by `files`: the projects containing them and
// the projects including those. Without any, compiles the project picked in
// the project quick pick.
async function compile(files: string[] = []): Promise<void> {
  if (!compiler) {
    return;
  }
  const { includingProjects } = compileSettings();
  const dirs = await affectedProjectDirs(files, knownProjects(), includingProjects);
  if (dirs.length === 0 && CompileCommands.currCwd) {
    dirs.push(CompileCommands.currCwd);
  }
  requestCompile(dirs);
}

// Projects compiled, or queued to compile, since their sources last changed.
const freshProjects = new Set<string>();

function requestCompile(dirs: string[]): void {
  dirs.forEach((dir) => freshProjects.add(dir));
  compiler?.compile(dirs);
}

// Compiles the project of a file being opened, unless it is up to date.
async function compileIfStale(file: string): Promise<void> {
  if (!compileSettings().onOpen || !file.endsWith(".p")) {
    return;
  }
  const dirs = await affectedProjectDirs([file], knownProjects(), false);
  const stale = dirs.filter((dir) => !freshProjects.has(dir));
  if (stale.length > 0) {
    requestCompile(stale);
  }
}

function knownProjects(): PProject[] {
  return CompileCommands.projects.map((p) => ({
    dir: p.description ?? "",
    pprojPath: path.join(p.description ?? "", p.label),
  }));
}

// A change makes its project stale, and every project including it, whether or
// not they are recompiled right away.
async function markStale(file: string): Promise<void> {
  for (const dir of await affectedProjectDirs([file], knownProjects())) {
    freshProjects.delete(dir);
  }
}

// "Save All" or a git checkout changes many files at once; coalesce them into
// one round of compiles.
function scheduleCompile(file: string): void {
  const marked = markStale(file);
  if (!compileSettings().onChange) {
    return;
  }
  changedFiles.push(file);
  pendingMarks.push(marked);
  clearTimeout(changeDebounce);
  changeDebounce = setTimeout(() => {
    const files = changedFiles;
    const marks = pendingMarks;
    changedFiles = [];
    pendingMarks = [];
    // Mark projects stale before the compile marks them fresh again.
    void Promise.all(marks).then(() => compile(files));
  }, 300);
}

/*
Shows message if there is no need to select a project.
Shows quick pick if there are multiple projects to compile.
*/
async function showFiles() {
  await generateProjects();
  if (CompileCommands.projects.length <= 0) {
    vscode.window.showInformationMessage(
      "There is no alternative P project to select because there is only one P project in the repository."
    );
  } else {
    const selection = await vscode.window.showQuickPick(
      CompileCommands.projects,
      CompileCommands.options
    );
    if (selection) {
      await compile();
    }
  }
}

// Change the active project WHEN the user selects a different item.
async function changeCompilationCommand(item: vscode.QuickPickItem) {
  const directory = item.description ?? "";
  CompileCommands.currCwd = directory;
  await TestingEditor.updateTestCasesList(directory || "**");
}

// Creates the compile task provider. The task itself uses ShellExecution with
// an explicit `cwd`, so we never interpolate paths into a shell string.
function createCompileTask() {
  const type = PCommands.RunTask;

  vscode.tasks.registerTaskProvider(type, {
    async provideTasks() {
      const pBinary = await resolvePBinary();
      if (!pBinary) {
        vscode.window.showErrorMessage(messages.Messages.Installation.noP);
        const msg = `echo "${messages.Messages.Installation.noP}"`;
        return [
          new vscode.Task(
            { type },
            vscode.TaskScope.Workspace,
            "Run_Report",
            "p-vscode",
            new vscode.ShellExecution(msg)
          ),
        ];
      }

      const cwd = CompileCommands.currCwd || undefined;
      const compileExecution = new vscode.ShellExecution(pBinary, ["compile"], { cwd });
      const problemMatchers = ["$Parse", "$Type"];

      return [
        new vscode.Task(
          { type },
          vscode.TaskScope.Workspace,
          "Compile",
          "p-vscode",
          compileExecution,
          problemMatchers
        ),
      ];
    },
    resolveTask(task: vscode.Task) {
      return task;
    },
  });
}

/*
Choose file to compile.
Case 1: No pproj file -> Error window
Case 2: One pproj file -> single project
Case 3: Multiple pproj files -> quick pick shows many lines
*/
async function generateProjects() {
  const files = await searchDirectory(path.join("**", "*.pproj"));
  if (files == null) {
    vscode.window.showErrorMessage(
      messages.Messages.CompilationStatus.NoDirectory
    );
    return;
  }
  if (files.length === 0) {
    vscode.window.showErrorMessage(
      messages.Messages.CompilationStatus.NoPprojFile
    );
    return;
  }

  if (files.length === 1) {
    const first = files[0];
    const fileName = path.parse(first.fsPath).base;
    const directory = path.dirname(first.fsPath);

    CompileCommands.projects = [{ label: fileName, description: directory }];
    CompileCommands.currCwd = directory;
    return;
  }

  CompileCommands.projects = files.map((f) => {
    const fileName = path.parse(f.fsPath).base;
    return { label: fileName, description: path.dirname(f.fsPath) };
  });

  const first = CompileCommands.projects[0];
  CompileCommands.currCwd = first.description ?? "";
}
