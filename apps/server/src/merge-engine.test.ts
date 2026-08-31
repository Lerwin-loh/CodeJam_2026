import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MergeConflictError, MergeEngine, conversationCommits, type MergeAiResolver } from "./merge-engine.js";
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

function side(id: string, workspacePath: string, baseSnapshot: Awaited<ReturnType<typeof fixture>>["baseSnapshot"], prompt: string, changedPaths = ["shared.txt"]) {
  const conversation = prompt ? [{ id: id + "-run", runId: id + "-run", branchId: null, prompt, response: id + " response", createdAt: "2026-01-01T00:00:00.000Z", changedPaths }] : [];
  return { id, label: id, workspacePath, baseSnapshot, prompts: prompt ? [prompt] : [], conversation, outcome: { id, label: id, summary: id + " complete", details: [id + " result"], requestedFeatures: [id + " feature"] } };
}

function commit(id: string, prompt: string, origin?: "base" | "target" | "source", changedPaths: string[] = []) {
  return { id, runId: id, branchId: null, prompt, response: prompt + " response", createdAt: "2026-01-01T00:00:00.000Z", origin, changedPaths };
}

describe("MergeEngine", () => {
  it("attaches each prompt to the files changed by its checkpoint", () => {
    const messages = [
      { id: "message-1", agentId: "agent", runId: "run-1", branchId: null, role: "user" as const, content: "change the login", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "message-2", agentId: "agent", runId: "run-1", branchId: null, role: "assistant" as const, content: "done", createdAt: "2026-01-01T00:00:01.000Z" },
    ];
    const runs = [{ id: "run-1", agentId: "agent", branchId: null, status: "completed" as const, prompt: "change the login", output: "done", error: null, usage: null, startedAt: null, completedAt: "2026-01-01T00:00:01.000Z", createdAt: "2026-01-01T00:00:00.000Z", beforeWorkspaceHash: "before", afterWorkspaceHash: "after", checkpointId: "checkpoint-1" }];
    const checkpoints = [{ id: "checkpoint-1", agentId: "agent", branchId: null, runId: "run-1", parentCheckpointId: null, snapshotId: "snapshot-1", contextId: "context-1", workspaceHash: "after", changedFiles: { created: ["login.ts"], modified: ["auth.ts"], deleted: [] }, status: "complete" as const, reason: "auto-mutation" as const, label: null, createdAt: "2026-01-01T00:00:01.000Z" }];

    expect(conversationCommits(messages, runs, checkpoints)[0]?.changedPaths).toEqual(["auth.ts", "login.ts"]);
  });

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
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "keep target instructions"); const source = side("source", f.source, f.baseSnapshot, "keep source instructions"); const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts.map((item) => item.path)).toContain("shared.txt"); expect(preview.contextConflicts).toHaveLength(1);
    await expect(engine.apply(target, source, { workspace: {}, context: {} }, async () => null)).rejects.toThrow("Resolve every merge conflict");
    const result = await engine.apply(target, source, { workspace: { "shared.txt": "source" }, context: { [preview.contextConflicts[0]!.id]: "ai" } }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual(["keep source instructions"]); expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("source\n");
  });

  it("resolves different code conflicts from different branches", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "first.txt"), "target first\n");
    await writeFile(path.join(f.source, "first.txt"), "source first\n");
    await writeFile(path.join(f.target, "second.txt"), "target second\n");
    await writeFile(path.join(f.source, "second.txt"), "source second\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "target prompt");
    const source = side("source", f.source, f.baseSnapshot, "source prompt");
    const preview = await engine.preview(target, source);
    const result = await engine.apply(target, source, {
      workspace: { "first.txt": "target", "second.txt": "source" },
      context: Object.fromEntries(preview.contextConflicts.map((conflict) => [conflict.id, "ai"])),
    }, async () => null);
    expect(await readFile(path.join(f.target, "first.txt"), "utf8")).toBe("target first\n");
    expect(await readFile(path.join(f.target, "second.txt"), "utf8")).toBe("source second\n");
    expect(result.conversation.map((item) => item.prompt)).toEqual(["target prompt", "source prompt"]);
  });

  it("detects semantic username/email conflicts and lets isolated AI keep the compatible login", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "login.html"), "<form id=login><input name=email><input name=password></form>\n");
    await writeFile(path.join(f.target, "verify.ts"), "sendVerification(email);\n");
    await writeFile(path.join(f.source, "login.html"), "<form id=login><input name=username><input name=password></form>\n");
    const ai: MergeAiResolver = {
      chooseWorkspace: async () => ({ choice: "target", explanation: "The target satisfies every criterion.", satisfiesAllCriteria: true }),
    };
    const engine = new MergeEngine(f.history, ai);
    const target = { ...side("target", f.target, f.baseSnapshot, "create an email login and use email for verification", ["login.html", "verify.ts"]), prompts: ["create an email login and use email for verification"] };
    const source = { ...side("source", f.source, f.baseSnapshot, "create a username login", ["login.html"]), prompts: ["create a username login"] };
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

  it("does not create a semantic conflict when identity code is in unrelated files", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "login.html"), "<input name=email>\n");
    await writeFile(path.join(f.source, "profile.html"), "<input name=username>\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "add email login", ["login.html"]);
    const source = side("source", f.source, f.baseSnapshot, "add username profile", ["profile.html"]);
    const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts).toHaveLength(0);
    expect(preview.contextConflicts).toHaveLength(0);
  });

  it("merges conversation units by ancestor slot and retains main post-base turns", async () => {
    const f = await fixture();
    const engine = new MergeEngine(f.history);
    const base = commit("base", "make login page", "base");
    const target = { ...side("target", f.target, f.baseSnapshot, ""), prompts: ["make login page", "use email to login", "add dashboard page"], conversation: [base, commit("email", "use email to login", "target"), commit("dashboard", "add dashboard page", "target")], baseConversation: [base] };
    const source = { ...side("source", f.source, f.baseSnapshot, ""), prompts: ["make login page", "use username to login"], conversation: [base, commit("username", "use username to login", "source")], baseConversation: [base] };
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(0);
    const result = await engine.apply(target, source, { workspace: {}, context: {} }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual(["make login page", "use email to login", "add dashboard page", "use username to login"]);
    expect(result.conversation.find((item) => item.prompt === "use username to login")?.response).toBe("use username to login response");
  });

  it("keeps independent same-anchor additions from both sides when prompt intents differ", async () => {
    const f = await fixture();
    const engine = new MergeEngine(f.history);
    const base = commit("base", "create a landing page", "base");
    const target = { ...side("target", f.target, f.baseSnapshot, ""), prompts: ["create a landing page", "add navigation bar"], conversation: [base, commit("nav", "add navigation bar", "target")], baseConversation: [base] };
    const source = { ...side("source", f.source, f.baseSnapshot, ""), prompts: ["create a landing page", "add hero section"], conversation: [base, commit("hero", "add hero section", "source")], baseConversation: [base] };
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(0);
    const result = await engine.apply(target, source, { workspace: {}, context: {} }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual(["create a landing page", "add navigation bar", "add hero section"]);
  });

  it("supports target choice and delete-versus-modify conversation conflicts", async () => {
    const f = await fixture();
    const engine = new MergeEngine(f.history);
    const base = commit("base", "shared instruction", "base");
    await writeFile(path.join(f.target, "shared.txt"), "target revision\n");
    await writeFile(path.join(f.source, "shared.txt"), "source revision\n");
    const target = { ...side("target", f.target, f.baseSnapshot, ""), prompts: ["shared instruction", "target revision"], conversation: [base, commit("target-revision", "target revision", "target", ["shared.txt"])], baseConversation: [base] };
    const source = { ...side("source", f.source, f.baseSnapshot, ""), conversation: [base, commit("source-revision", "source revision", "source", ["shared.txt"])], prompts: ["shared instruction", "source revision"], baseConversation: [base] };
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(1);
    const targetResult = await engine.apply(target, source, { workspace: { "shared.txt": "target" }, context: { [preview.contextConflicts[0]!.id]: "target" } }, async () => null);
    expect(targetResult.conversation.map((item) => item.prompt)).toEqual(["shared instruction", "target revision"]);

    const deletedTarget = { ...target, conversation: [], prompts: [], baseConversation: [base] };
    const modifiedSource = { ...source, conversation: [commit("base", "source revision", "source")], prompts: ["source revision"] };
    const deletePreview = await engine.preview(deletedTarget, modifiedSource);
    expect(deletePreview.contextConflicts).toHaveLength(0);
    const deleteResult = await engine.apply(deletedTarget, modifiedSource, { workspace: { "shared.txt": "target" }, context: {} }, async () => null);
    expect(deleteResult.conversation.map((item) => item.prompt)).toEqual(["source revision"]);
  });

  it("does not create prompt conflicts for similar prompts on unrelated files", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "target.ts"), "target\n");
    await writeFile(path.join(f.source, "source.ts"), "source\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "add a navigation component", ["target.ts"]);
    const source = side("source", f.source, f.baseSnapshot, "add a navigation component", ["source.ts"]);
    const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts).toHaveLength(0);
    expect(preview.contextConflicts).toHaveLength(0);
    const result = await engine.apply(target, source, { workspace: {}, context: {} }, async () => null);
    expect(result.conversation.map((item) => item.prompt)).toEqual(["add a navigation component", "add a navigation component"]);
  });

  it("does not attribute a code conflict to prompts that changed no files", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "shared.txt"), "target\n");
    await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "explain the implementation", []);
    const source = side("source", f.source, f.baseSnapshot, "explain the implementation", []);
    const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts.map((item) => item.path)).toEqual(["shared.txt"]);
    expect(preview.contextConflicts).toHaveLength(0);
    const result = await engine.apply(target, source, { workspace: { "shared.txt": "source" }, context: {} }, async () => null);
    expect(result.provenance).toHaveLength(0);
    expect(result.conversation).toHaveLength(2);
  });

  it("links every prompt that contributed to a conflicting file", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "shared.txt"), "target\n");
    await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const engine = new MergeEngine(f.history);
    const target = {
      ...side("target", f.target, f.baseSnapshot, "first target change", ["shared.txt"]),
      conversation: [
        commit("target-1", "first target change", "target", ["shared.txt"]),
        commit("target-2", "second target change", "target", ["shared.txt"]),
      ],
      prompts: ["first target change", "second target change"],
    };
    const source = {
      ...side("source", f.source, f.baseSnapshot, "first source change", ["shared.txt"]),
      conversation: [
        commit("source-1", "first source change", "source", ["shared.txt"]),
        commit("source-2", "second source change", "source", ["shared.txt"]),
      ],
      prompts: ["first source change", "second source change"],
    };
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(1);
    expect(preview.contextConflicts[0]?.targetCommits?.map((item) => item.prompt)).toEqual([
      "first target change",
      "second target change",
    ]);
    expect(preview.contextConflicts[0]?.sourceCommits?.map((item) => item.prompt)).toEqual([
      "first source change",
      "second source change",
    ]);
  });

  it("keeps both prompts and records provenance when file choices are mixed", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "first.txt"), "target first\n");
    await writeFile(path.join(f.source, "first.txt"), "source first\n");
    await writeFile(path.join(f.target, "second.txt"), "target second\n");
    await writeFile(path.join(f.source, "second.txt"), "source second\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "implement the target feature", ["first.txt", "second.txt"]);
    const source = side("source", f.source, f.baseSnapshot, "implement the source feature", ["first.txt", "second.txt"]);
    const preview = await engine.preview(target, source);
    expect(preview.contextConflicts).toHaveLength(1);
    const result = await engine.apply(target, source, {
      workspace: { "first.txt": "target", "second.txt": "source" },
      context: { [preview.contextConflicts[0]!.id]: "ai" },
    }, async () => null);
    expect(await readFile(path.join(f.target, "first.txt"), "utf8")).toBe("target first\n");
    expect(await readFile(path.join(f.target, "second.txt"), "utf8")).toBe("source second\n");
    expect(result.conversation.map((item) => item.prompt)).toEqual(["implement the target feature", "implement the source feature"]);
    expect(result.provenance[0]).toMatchObject({ mode: "automatic", paths: ["first.txt", "second.txt"] });
  });

  it("writes AI-combined code and records the merge instruction", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "shared.txt"), "target\n");
    await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const engine = new MergeEngine(f.history, {
      chooseWorkspace: async () => ({
        choice: "combined",
        content: "target and source\n",
        mergePrompt: "Combine the target and source implementations.",
        explanation: "Both compatible changes were retained.",
      }),
    });
    const target = side("target", f.target, f.baseSnapshot, "implement target behavior");
    const source = side("source", f.source, f.baseSnapshot, "implement source behavior");
    const preview = await engine.preview(target, source);
    const result = await engine.apply(target, source, {
      workspace: { "shared.txt": "ai" },
      context: { [preview.contextConflicts[0]!.id]: "ai" },
    }, async () => null);
    expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("target and source\n");
    expect(result.conversation.map((item) => item.prompt)).toEqual(["implement target behavior", "implement source behavior"]);
    expect(result.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "ai", mergePrompt: "Combine the target and source implementations." }),
    ]));
  });

  it("rejects an invalid AI-combined body without applying a partial merge", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "shared.txt"), "target\n");
    await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const engine = new MergeEngine(f.history, {
      chooseWorkspace: async () => ({
        choice: "combined",
        content: "",
        mergePrompt: "Combine both implementations.",
        explanation: "The output was incomplete.",
      }),
    });
    const target = side("target", f.target, f.baseSnapshot, "implement target behavior");
    const source = side("source", f.source, f.baseSnapshot, "implement source behavior");
    const preview = await engine.preview(target, source);

    await expect(engine.apply(target, source, {
      workspace: { "shared.txt": "ai" },
      context: { [preview.contextConflicts[0]!.id]: "ai" },
    }, async () => null)).rejects.toBeInstanceOf(MergeConflictError);
    expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("target\n");
  });

  it("rejects an unverified AI side choice instead of silently selecting a branch", async () => {
    const f = await fixture();
    await writeFile(path.join(f.target, "shared.txt"), "target\n");
    await writeFile(path.join(f.source, "shared.txt"), "source\n");
    const engine = new MergeEngine(f.history, {
      chooseWorkspace: async () => ({ choice: "target", explanation: "Target looks better." }),
    });
    const target = side("target", f.target, f.baseSnapshot, "implement target behavior");
    const source = side("source", f.source, f.baseSnapshot, "implement source behavior");
    const preview = await engine.preview(target, source);

    await expect(engine.apply(target, source, {
      workspace: { "shared.txt": "ai" },
      context: { [preview.contextConflicts[0]!.id]: "ai" },
    }, async () => null)).rejects.toBeInstanceOf(MergeConflictError);
    expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("target\n");
  });

  it("records provenance for a clean three-way merge that uses both implementations", async () => {
    const f = await fixture("one\ntwo\nthree\n");
    await writeFile(path.join(f.target, "shared.txt"), "ONE\ntwo\nthree\n");
    await writeFile(path.join(f.source, "shared.txt"), "one\ntwo\nTHREE\n");
    const engine = new MergeEngine(f.history);
    const target = side("target", f.target, f.baseSnapshot, "uppercase the first line");
    const source = side("source", f.source, f.baseSnapshot, "uppercase the last line");
    const preview = await engine.preview(target, source);
    expect(preview.workspaceConflicts).toHaveLength(0);
    expect(preview.combinedFiles).toHaveLength(1);
    const result = await engine.apply(target, source, { workspace: {}, context: {} }, async () => null);
    expect(await readFile(path.join(f.target, "shared.txt"), "utf8")).toBe("ONE\ntwo\nTHREE\n");
    expect(result.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "automatic", paths: ["shared.txt"] }),
    ]));
  });
});
