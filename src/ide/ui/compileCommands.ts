import * as path from "path";
import * as vscode from "vscode";
import * as messages from "./messages";

import { checkPInstalled, searchDirectory } from "../../miscTools";
import { PCommands } from "../../commands";
import BackgroundCompiler from "./backgroundCompiler";
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

    context.subscriptions.push(
      compiler,
      vscode.commands.registerCommand("peasy.showProjectFiles", () => showFiles()),
      vscode.commands.registerCommand("peasy.compile", () => compile()),
      vscode.commands.registerCommand(showCompilerOutputCommand, () =>
        compiler?.showOutput()
      ),
      vscode.workspace.onDidDeleteFiles(() => generateProjects()),
      vscode.workspace.onDidCreateFiles(() => generateProjects()),
      vscode.workspace.onDidSaveTextDocument((e) => {
        if (e.fileName.endsWith(".p") || e.fileName.endsWith(".pproj")) {
          scheduleCompileOnSave();
        }
      }),
      {
        dispose: () => clearTimeout(saveDebounce),
      }
    );

    return new CompileCommands();
  }
}

const showCompilerOutputCommand = "peasy.showCompilerOutput";
let compiler: BackgroundCompiler | undefined;
let saveDebounce: NodeJS.Timeout | undefined;

function compile(): void {
  if (compiler && CompileCommands.currCwd) {
    compiler.compile([CompileCommands.currCwd]);
  }
}

// "Save All" fires one event per file; coalesce them into one compile.
function scheduleCompileOnSave(): void {
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => void compile(), 200);
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
      compile();
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
      const p_installed = await checkPInstalled();
      if (!p_installed) {
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
      const compileExecution = new vscode.ShellExecution("p", ["compile"], { cwd });
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
