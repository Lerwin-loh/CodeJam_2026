import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MergeEngine, type MergeAiResolver } from "./merge-engine.js";
import { WorkspaceHistory } from "./workspace-history.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(baseText = "base\n") {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-merge-engine-")); roots.push(root);
  const history = new WorkspaceHistory(path.join(root, "history")); await history.initialize();
  const target = path.join(root, "target"); const source = path.join(root, "source"); const base = path.join(root, "base");
  await Promise.all([mkdir(target), mkdir(source), mkdir(base)]);
  await Promise.all([writeFile(path.join(target, "shared.txt"), baseText), writeFile(path.join(source, "shared.txt"), baseText), writeFile(path.join(base, "shared.txt"), baseText)]);
  const baseManifest = await history.manifest(base);
  const baseSnapshot = await history.createSnapshot("base-agent", null, base, baseManifest);
  return { history, target, source, baseSnapshot };
}

function side(id: string, workspacePath: string, baseSnapshot: Awaited<ReturnType<typeof fixture>>["baseSnapshot"], prompt: string) {
  const conversation = prompt ? [{ id: id + "-run", runId: id + "-run", branchId: null, prompt, response: id + " response", createdAt: "2026-01-01T00:00:00.000Z" }] : [];
  return { id, label: id, workspacePath, baseSnapshot, prompts: prompt ? [prompt] : [], conversation, outcome: { id, label: id, summary: id + " complete", details: [id + " result"], requestedFeatures: [id + " feature"] } };
}

function commit(id: string, prompt: string, origin?: "base" | "target" | "source") {
  return { id, runId: id, branchId: null, prompt, response: prompt + " response", createdAt: "2026-01-01T00:00:00.000Z", origin };
}

describe("MergeEngine", () => {
  it("combines independent changes and both complete outcomes", async () => {
    const f = await fixture(); await writeFile(path.join(f.target, "target.txt"), "target\n"); await writeFile(path.join(f.source, "source.txt"), "source\n");
    const engine = new MergeEngine(f.history); const preview = await engine.preview(side("target", f.target, f.baseSnapshot, "",), side("source", f.source, f.baseSnapshot, ""));
    expect(preview.workspaceConflicts).toHaveLength(0); expect(preview.acceptanceCriteria).toEqual(expect.arrayContaining(["target complete", "source complete", "target result", "source result"]));
    const result = await engine.apply(side("target", f.target, f.baseSnapshot, ""), side("source", f.source, f.baseSnapshot, ""), { workspace: {}, context: {} }, async () => null);
    expect(result.snapshot).toBeNull(); expect(await readFile(path.join(f.target, "target.txt"), "utf8")).toBe("target\n"); expect(await readFile(path.join(f.target, "source.txt"), "utf8")).toBe("source\n");
  });

  it("auto-merges non-overlapping edits to the same file like git", async () => {
    const f = await fixture("one\ntwo\nthree\n");
    await writeFile(path.join(f.target, "shared.txt"), "ONE\ntwo\nthree\n");
    await writeFile(path.join(f.source, "shared.txt"), "one\ntwo\nTHREE\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "");
    const source = side("source", f.source, f.baseSnapshot, "");
    const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts).toHaveLength(0);
    await engine.apply(target, source, { workspace: {}, context: {} }, async () => null);
    expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("requires workspace and prompt conflict choices, and retains only the selected prompt", async () => {
    const f = await fixture(); await writeFile(path.join(f.target, "shared.txt"), "target\n"); await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const ai: MergeAiResolver = { choosePrompt: async () => "source" }; const engine = new MergeEngine(f.history, ai);
    const target = side("target", f.target, f.baseSnapshot, "keep target instructions"); const source = side("source", f.source, f.baseSnapshot, "keep source instructions"); const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts.map((item) => item.path)).toContain("shared.txt"); expect(preview.contextConflicts).toHaveLength(1);
    await expect(engine.apply(target, source, { workspace: {}, context: {} }, async () => null)).rejects.toThrow("Resolve every merge conflict");
    const result = await engine.apply(target, source, { workspace: { "shared.txt": "source" }, context: { [preview.contextConflicts[0]!.id]: "ai" } }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual(["keep source instructions"]); expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("source\n");
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

    expect(preview.contextConflicts[0]).toMatchObject({ target: { prompt: target.prompts[0] }, source: { prompt: source.prompts[0] } });
    expect(preview.workspaceConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "semantic:login-identity", targetPaths: expect.arrayContaining(["login.html", "verify.ts"]), sourcePaths: ["login.html"] }),
    ]));

    const result = await engine.apply(target, source, {
      workspace: { "semantic:login-identity": "ai", "login.html": "ai" },
      context: { [preview.contextConflicts[0]!.id]: "ai" },
    }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual([target.prompts[0]]);
    expect(await readFile(path.join(f.target, "login.html"), "utf8")).toContain("email");
    expect(await readFile(path.join(f.target, "verify.ts"), "utf8")).toContain("sendVerification");
  });

  it("merges conversation units by ancestor slot and retains main post-base turns", async () => {
    const f = await fixture();
    const engine = new MergeEngine(f.history);
    const base = commit("base", "make login page", "base");
    const target = { ...side("target", f.target, f.baseSnapshot, ""), prompts: ["make login page", "use email to login", "add dashboard page"], conversation: [base, commit("email", "use email to login", "target"), commit("dashboard", "add dashboard page", "target")], baseConversation: [base] };
    const source = { ...side("source", f.source, f.baseSnapshot, ""), prompts: ["make login page", "use username to login"], conversation: [base, commit("username", "use username to login", "source")], baseConversation: [base] };
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(1);
    const result = await engine.apply(target, source, { workspace: {}, context: { [preview.contextConflicts[0]!.id]: "source" } }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual(["make login page", "use username to login", "add dashboard page"]);
    expect(result.conversation.find((item) => item.prompt === "use username to login")?.response).toBe("use username to login response");
  });

  it("supports target choice and delete-versus-modify conversation conflicts", async () => {
    const f = await fixture();
    const engine = new MergeEngine(f.history);
    const base = commit("base", "shared instruction", "base");
    const target = { ...side("target", f.target, f.baseSnapshot, ""), prompts: ["shared instruction", "target revision"], conversation: [base, commit("target-revision", "target revision", "target")], baseConversation: [base] };
    const source = { ...side("source", f.source, f.baseSnapshot, ""), conversation: [base, commit("source-revision", "source revision", "source")], prompts: ["shared instruction", "source revision"], baseConversation: [base] };
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(1);
    const targetResult = await engine.apply(target, source, { workspace: {}, context: { [preview.contextConflicts[0]!.id]: "target" } }, async () => null);
    expect(targetResult.conversation.map((item) => item.prompt)).toEqual(["shared instruction", "target revision"]);

    const deletedTarget = { ...target, conversation: [], prompts: [], baseConversation: [base] };
    const modifiedSource = { ...source, conversation: [commit("base", "source revision", "source")], prompts: ["source revision"] };
    const deletePreview = await engine.preview(deletedTarget, modifiedSource);
    expect(deletePreview.contextConflicts).toHaveLength(1);
    const deleteResult = await engine.apply(deletedTarget, modifiedSource, { workspace: {}, context: { [deletePreview.contextConflicts[0]!.id]: "target" } }, async () => null);
    expect(deleteResult.conversation).toEqual([]);
  });
});
