import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("captures observable tool activity without exposing unbounded output", () => {
    const parsed = {
      messages: [],
      threadId: null,
      usage: null,
      errors: [],
      events: [],
    };
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          exit_code: 0,
          aggregated_output: "x".repeat(3_000),
        },
      }),
      parsed,
    );
    expect(parsed.events[0]).toMatchObject({
      type: "command_execution",
      metadata: { codexType: "item.completed", command: "npm test", exit_code: 0 },
    });
    expect((parsed.events[0]?.metadata.output as string).length).toBe(2_000);

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "error",
          message: "Connection interrupted; retrying.",
        },
      }),
      parsed,
    );
    expect(parsed.events[1]).toMatchObject({
      type: "error",
      metadata: {
        codexType: "item.completed",
        itemType: "error",
        message: "Connection interrupted; retrying.",
      },
    });

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "private model reasoning" },
      }),
      parsed,
    );
    expect(parsed.events[2]).toMatchObject({
      type: "reasoning",
      metadata: { codexType: "item.completed", itemType: "reasoning" },
    });
    expect(parsed.events[2]?.metadata).not.toHaveProperty("output");
  });
});
