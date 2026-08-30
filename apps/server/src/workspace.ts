import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  branchWorkspacePath(agentWorkspacePath: string, branchId: string): string {
    return path.join(agentWorkspacePath, "branches", branchId);
  }

  projectMainPath(projectId: string): string {
    return path.join(this.root, "projects", projectId, "main");
  }

  projectPath(projectId: string): string {
    return path.join(this.root, "projects", projectId);
  }

  projectMemberPath(projectId: string, memberId: string): string {
    return path.join(this.root, "projects", projectId, "members", memberId);
  }

  /**
   * Stage an existing standalone workspace as a project's canonical main tree.
   * The source stays untouched until the caller has committed its metadata, so
   * a failed upgrade never leaves the standalone Agent without a workspace.
   */
  async copyStandaloneToProject(sourcePath: string, projectId: string): Promise<string> {
    const source = path.resolve(sourcePath);
    const workspaceRoot = path.resolve(this.root) + path.sep;
    if (!source.startsWith(workspaceRoot) || source === path.resolve(this.root)) {
      throw new Error("Standalone workspace is outside the managed workspace root");
    }
    const target = this.projectMainPath(projectId);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await cp(source, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      return target;
    } catch (error) {
      await rm(this.projectPath(projectId), { recursive: true, force: true });
      throw error;
    }
  }

  /** Remove only a not-yet-committed project copy after a failed upgrade. */
  async discardProjectCopy(projectId: string): Promise<void> {
    await rm(this.projectPath(projectId), { recursive: true, force: true });
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const projectRole =
      agent.kind === "parent"
        ? [
            "## Project role",
            "",
            "- You are the parent Agent for this project.",
            "- This workspace is the project's canonical main workspace.",
            "- Preserve reviewed team changes and keep project-level work coherent.",
            "",
          ]
        : [];
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      ...projectRole,
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }

  /** Move a branch workspace under `.deleted/` (used when a branch is merged away). */
  async archiveBranch(branchId: string, workspacePath: string): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveRoot = path.join(this.root, ".deleted", "branches");
    const destination = path.join(archiveRoot, branchId + "-" + timestamp);
    await mkdir(archiveRoot, { recursive: true });
    try {
      await rename(workspacePath, destination);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async archiveProject(projectId: string): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveRoot = path.join(this.root, ".deleted", "projects");
    const destination = path.join(archiveRoot, projectId + "-" + timestamp);
    await mkdir(archiveRoot, { recursive: true });
    try {
      await rename(this.projectPath(projectId), destination);
      return destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
