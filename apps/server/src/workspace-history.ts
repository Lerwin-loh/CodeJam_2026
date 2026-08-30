import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
    ChangedFiles,
    WorkspaceFile,
    WorkspaceManifest,
    WorkspaceSnapshot,
} from "./types.js";

// Branch workspaces live beside their source workspace, but are platform state:
// never include them recursively in source manifests, snapshots, or restores.
const ignoredNames = new Set([".codex", ".git", "node_modules", "dist", "branches"]);

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
    runId: string | null,
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

  async restoreSnapshot(snapshot: WorkspaceSnapshot, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    const allowedFiles = new Set(snapshot.manifest.files.map((file) => file.path));
    await this.removeUnexpectedFiles(destination, allowedFiles);

    for (const file of snapshot.manifest.files) {
      const source = path.join(snapshot.directory, "files", file.path);
      const target = path.join(destination, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true, recursive: false, preserveTimestamps: true });
      await chmod(target, file.mode);
    }
  }

  /**
   * Replace an active workspace with a snapshot while preserving directories
   * owned by the platform or Runtime. The replacement is prepared and hashed
   * before publication; if publication fails, the original workspace is put
   * back in place.
   */
  async restoreSnapshotInPlace(
    snapshot: WorkspaceSnapshot,
    destination: string,
  ): Promise<void> {
    const operationId = randomUUID();
    const parent = path.dirname(destination);
    const base = path.basename(destination);
    const staging = path.join(parent, `.${base}.restore-${operationId}`);
    const backup = path.join(parent, `.${base}.before-restore-${operationId}`);
    let originalMoved = false;
    let replacementPublished = false;

    try {
      await this.restoreSnapshot(snapshot, staging);
      const stagedManifest = await this.manifest(staging);
      if (stagedManifest.workspaceHash !== snapshot.manifest.workspaceHash) {
        throw new Error("The staged workspace does not match the checkpoint snapshot");
      }

      // Copy platform/Runtime-owned state into the fully prepared replacement
      // before the directory swap. The original stays intact and is therefore
      // sufficient for rollback until publication has been verified.
      for (const name of ignoredNames) {
        try {
          await cp(path.join(destination, name), path.join(staging, name), {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      await rename(destination, backup);
      originalMoved = true;
      await rename(staging, destination);
      replacementPublished = true;

      const restoredManifest = await this.manifest(destination);
      if (restoredManifest.workspaceHash !== snapshot.manifest.workspaceHash) {
        throw new Error("The active workspace does not match the checkpoint snapshot");
      }
    } catch (error) {
      if (originalMoved) {
        if (replacementPublished) {
          await rm(destination, { recursive: true, force: true });
        }
        await rename(backup, destination);
      }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }

    // The active workspace is already verified and authoritative. Failure to
    // remove this private backup must not turn a successful restore into an
    // apparent failure; a later cleanup can safely remove the orphan.
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }

  async archiveSnapshots(
    projectId: string,
    snapshots: WorkspaceSnapshot[],
  ): Promise<number> {
    if (snapshots.length === 0) return 0;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveRoot = path.join(
      this.root,
      ".deleted",
      projectId + "-" + timestamp,
      "snapshots",
    );
    const snapshotRoot = path.resolve(this.root, "snapshots") + path.sep;
    let archived = 0;
    for (const snapshot of snapshots) {
      const source = path.resolve(snapshot.directory);
      if (!source.startsWith(snapshotRoot)) continue;
      await mkdir(archiveRoot, { recursive: true });
      try {
        await rename(source, path.join(archiveRoot, snapshot.id));
        archived += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return archived;
  }

  private async removeUnexpectedFiles(workspacePath: string, allowedFiles: Set<string>): Promise<void> {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const absolutePath = path.join(workspacePath, entry.name);
      const relativePath = path.relative(workspacePath, absolutePath).split(path.sep).join("/");
      if (!allowedFiles.has(relativePath)) {
        await rm(absolutePath, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) {
        await this.removeUnexpectedFiles(absolutePath, allowedFiles);
      }
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
