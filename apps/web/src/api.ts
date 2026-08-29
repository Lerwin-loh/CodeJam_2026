import type { Agent, AgentCheckpoint, AgentRun, CheckpointDetails, CheckpointDiff, Message, RunDetails, SystemInfo, TraceEvent } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  checkpoints: (id: string) =>
    request<{ checkpoints: AgentCheckpoint[] }>("/api/agents/" + id + "/checkpoints"),
  trace: (id: string) =>
    request<{ events: TraceEvent[] }>("/api/agents/" + id + "/trace"),
  checkpointDetails: (id: string) =>
    request<CheckpointDetails>("/api/checkpoints/" + id + "/details"),
  checkpointDiff: (id: string) =>
    request<{ diff: CheckpointDiff }>("/api/checkpoints/" + id + "/diff"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runDetails: (id: string) => request<RunDetails>("/api/runs/" + id + "/details"),
  restoreCheckpoint: (id: string) =>
    request<{ workspacePath: string; workspaceHash: string }>("/api/checkpoints/" + id + "/restore", { method: "POST" }),
  streamRunTrace: async (id: string, onEvent: (event: TraceEvent) => void, signal?: AbortSignal): Promise<void> => {
    const response = await fetch("/api/runs/" + id + "/trace/stream", {
      headers: authToken ? { Authorization: "Bearer " + authToken } : undefined,
      signal,
    });
    if (!response.ok || !response.body) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? "Trace stream failed", response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        try { onEvent(JSON.parse(dataLine.slice(6)) as TraceEvent); } catch { /* refresh fallback */ }
      }
      if (done) return;
    }
  },
};
