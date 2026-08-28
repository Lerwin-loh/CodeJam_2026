import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceHistory } from "./workspace-history.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspaceHistory", () => {
  it("hashes files, classifies changes, and materializes an immutable snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-history-test-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const history = new WorkspaceHistory(path.join(root, "branchpoint"));
    await history.initialize();
    await (await import("node:fs/promises")).mkdir(workspace);
    await writeFile(path.join(workspace, "before.txt"), "before\n");
    const before = await history.manifest(workspace);
    await writeFile(path.join(workspace, "before.txt"), "after\n");
    await writeFile(path.join(workspace, "created.txt"), "created\n");
    const after = await history.manifest(workspace);
    const changed = history.diff(before, after);

    expect(before.workspaceHash).not.toBe(after.workspaceHash);
    expect(changed).toEqual({ created: ["created.txt"], modified: ["before.txt"], deleted: [] });

    const snapshot = await history.createSnapshot("agent-1", "run-1", workspace, after);
    expect(await readFile(path.join(snapshot.directory, "files", "created.txt"), "utf8")).toBe("created\n");
    expect(JSON.parse(await readFile(path.join(snapshot.directory, "manifest.json"), "utf8"))).toEqual(after);
  });

  it("ignores generated dependency and output directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-history-ignore-test-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const history = new WorkspaceHistory(path.join(root, "branchpoint"));
    await history.initialize();
    await (await import("node:fs/promises")).mkdir(path.join(workspace, "node_modules"), { recursive: true });
    await (await import("node:fs/promises")).mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "node_modules", "ignored.js"), "ignored");
    await writeFile(path.join(workspace, "src", "kept.ts"), "kept");

    const manifest = await history.manifest(workspace);
    expect(manifest.files.map((file) => file.path)).toEqual(["src/kept.ts"]);
  });
});
