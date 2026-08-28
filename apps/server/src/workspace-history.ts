import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChangedFiles,
  WorkspaceFile,
  WorkspaceManifest,
  WorkspaceSnapshot,
} from "./types.js";

const ignoredNames = new Set([".codex", ".git", "node_modules", "dist"]);

export class WorkspaceHistory {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.join(this.root, "snapshots"), { recursive: true });
  }

  async manifest(workspacePath: string): Promise<WorkspaceManifest> {
    const files: WorkspaceFile[] = [];
    await this.collectFiles(workspacePath, workspacePath, files);
    files.sort((left, right) => left.path.localeCompare(right.path));
    const hashInput = files
      .map((file) => [file.path, file.size, file.sha256, file.mode].join("\0"))
      .join("\n");
    return {
      workspaceHash: createHash("sha256").update(hashInput).digest("hex"),
      files,
      createdAt: new Date().toISOString(),
    };
  }

  diff(before: WorkspaceManifest, after: WorkspaceManifest): ChangedFiles {
    const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
    const afterFiles = new Map(after.files.map((file) => [file.path, file]));
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [filePath, file] of afterFiles) {
      const previous = beforeFiles.get(filePath);
      if (!previous) created.push(filePath);
      else if (previous.sha256 !== file.sha256 || previous.mode !== file.mode) modified.push(filePath);
    }
    for (const filePath of beforeFiles.keys()) {
      if (!afterFiles.has(filePath)) deleted.push(filePath);
    }
    return { created, modified, deleted };
  }

  async createSnapshot(
    agentId: string,
    runId: string,
    workspacePath: string,
    manifest: WorkspaceManifest,
  ): Promise<WorkspaceSnapshot> {
    const id = randomUUID();
    const stagingDirectory = path.join(this.root, "snapshots", ".staging-" + id);
    const directory = path.join(this.root, "snapshots", id);
    await mkdir(path.join(stagingDirectory, "files"), { recursive: true });
    try {
      for (const file of manifest.files) {
        const source = path.join(workspacePath, file.path);
        const destination = path.join(stagingDirectory, "files", file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(source, destination, { preserveTimestamps: true });
      }
      await writeFile(
        path.join(stagingDirectory, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(stagingDirectory, directory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    return {
      id,
      agentId,
      runId,
      directory,
      manifest,
      createdAt: new Date().toISOString(),
    };
  }

  async readSnapshotFile(snapshot: WorkspaceSnapshot, filePath: string): Promise<string | null> {
    try {
      const target = path.join(snapshot.directory, "files", filePath);
      const resolved = path.resolve(target);
      const root = path.resolve(snapshot.directory, "files") + path.sep;
      if (!resolved.startsWith(root)) return null;
      const content = await readFile(resolved, "utf8");
      return content.slice(0, 50_000);
    } catch {
      return null;
    }
  }

  private async collectFiles(
    root: string,
    current: string,
    files: WorkspaceFile[],
  ): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await this.collectFiles(root, absolutePath, files);
        continue;
      }
      if (!info.isFile()) continue;
      const digest = createHash("sha256");
      const content = await readFile(absolutePath);
      digest.update(content);
      files.push({
        path: relativePath.split(path.sep).join("/"),
        size: info.size,
        sha256: digest.digest("hex"),
        mode: info.mode & 0o777,
      });
    }
  }
}
