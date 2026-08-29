import type { Agent, AgentCheckpoint, AgentRun, AuditEntry, CheckpointDetails, CheckpointDiff, Message, SystemInfo, TraceEvent, User } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "launchpad.userToken";

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let authToken = readStoredToken();

export function setAuthToken(token: string): void {
  authToken = token.trim();
  try {
    if (authToken) localStorage.setItem(TOKEN_KEY, authToken);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — keep the in-memory token only */
  }
}

export function getStoredToken(): string {
  return authToken;
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
  createUser: (name: string) =>
    request<{ user: User & { token: string } }>("/api/users", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  me: () => request<{ user: User }>("/api/me"),
  audit: () => request<{ entries: AuditEntry[] }>("/api/audit"),
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
  createCheckpoint: (id: string, label: string) =>
    request<{ checkpoint: AgentCheckpoint }>("/api/agents/" + id + "/checkpoints", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
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
};
