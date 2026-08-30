import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MergeEngine, type MergeAiResolver } from "./merge-engine.js";
import { WorkspaceHistory } from "./workspace-history.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-merge-engine-")); roots.push(root);
  const history = new WorkspaceHistory(path.join(root, "history")); await history.initialize();
  const target = path.join(root, "target"); const source = path.join(root, "source"); const base = path.join(root, "base");
  await Promise.all([mkdir(target), mkdir(source), mkdir(base)]);
  await Promise.all([writeFile(path.join(target, "shared.txt"), "base\n"), writeFile(path.join(source, "shared.txt"), "base\n"), writeFile(path.join(base, "shared.txt"), "base\n")]);
  const baseManifest = await history.manifest(base);
  const baseSnapshot = await history.createSnapshot("base-agent", null, base, baseManifest);
  return { history, target, source, baseSnapshot };
}

function side(id: string, workspacePath: string, baseSnapshot: Awaited<ReturnType<typeof fixture>>["baseSnapshot"], prompt: string) {
  return { id, label: id, workspacePath, baseSnapshot, prompts: [prompt], outcome: { id, label: id, summary: id + " complete", details: [id + " result"], requestedFeatures: [id + " feature"] } };
}

describe("MergeEngine", () => {
  it("combines independent changes and both complete outcomes", async () => {
    const f = await fixture(); await writeFile(path.join(f.target, "target.txt"), "target\n"); await writeFile(path.join(f.source, "source.txt"), "source\n");
    const engine = new MergeEngine(f.history); const preview = await engine.preview(side("target", f.target, f.baseSnapshot, "",), side("source", f.source, f.baseSnapshot, ""));
    expect(preview.workspaceConflicts).toHaveLength(0); expect(preview.acceptanceCriteria).toEqual(expect.arrayContaining(["target complete", "source complete", "target feature", "source feature"]));
    const result = await engine.apply(side("target", f.target, f.baseSnapshot, ""), side("source", f.source, f.baseSnapshot, ""), { workspace: {}, context: {} }, async () => null);
    expect(result.snapshot).toBeNull(); expect(await readFile(path.join(f.target, "target.txt"), "utf8")).toBe("target\n"); expect(await readFile(path.join(f.target, "source.txt"), "utf8")).toBe("source\n");
  });

  it("requires workspace and prompt conflict choices, and retains only the selected prompt", async () => {
    const f = await fixture(); await writeFile(path.join(f.target, "shared.txt"), "target\n"); await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const ai: MergeAiResolver = { choosePrompt: async () => "source" }; const engine = new MergeEngine(f.history, ai);
    const target = side("target", f.target, f.baseSnapshot, "keep target instructions"); const source = side("source", f.source, f.baseSnapshot, "keep source instructions"); const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts.map((item) => item.path)).toContain("shared.txt"); expect(preview.contextConflicts).toHaveLength(1);
    await expect(engine.apply(target, source, { workspace: {}, context: {} }, async () => null)).rejects.toThrow("Resolve every merge conflict");
    const result = await engine.apply(target, source, { workspace: { "shared.txt": "source" }, context: { [preview.contextConflicts[0]!.id]: "ai" } }, async () => null);
    expect(result.keptPrompts).toEqual(["keep source instructions"]); expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("source\n");
  });

  it("detects semantic username/email conflicts and lets isolated AI keep the compatible login", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "login.html"), "<form id=login><input name=email><input name=password></form>\n");
    await writeFile(path.join(f.target, "verify.ts"), "sendVerification(email);\n");
    await writeFile(path.join(f.source, "login.html"), "<form id=login><input name=username><input name=password></form>\n");
    const ai: MergeAiResolver = {
      choosePrompt: async () => "target",
      chooseWorkspace: async () => "target",
    };
    const engine = new MergeEngine(f.history, ai);
    const target = { ...side("target", f.target, f.baseSnapshot, "create an email login and use email for verification"), prompts: ["create an email login and use email for verification"] };
    const source = { ...side("source", f.source, f.baseSnapshot, "create a username login"), prompts: ["create a username login"] };
    const preview = await engine.preview(target, source);

    expect(preview.contextConflicts[0]).toMatchObject({ targetPrompt: target.prompts[0], sourcePrompt: source.prompts[0] });
    expect(preview.workspaceConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "semantic:login-identity", targetPaths: expect.arrayContaining(["login.html", "verify.ts"]), sourcePaths: ["login.html"] }),
    ]));

    const result = await engine.apply(target, source, {
      workspace: { "semantic:login-identity": "ai", "login.html": "ai" },
      context: { [preview.contextConflicts[0]!.id]: "ai" },
    }, async () => null);
    expect(result.keptPrompts).toEqual([target.prompts[0]]);
    expect(await readFile(path.join(f.target, "login.html"), "utf8")).toContain("email");
    expect(await readFile(path.join(f.target, "verify.ts"), "utf8")).toContain("sendVerification");
  });
});
