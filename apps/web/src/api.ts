import type {
  Agent,
  AgentCheckpoint,
  AgentRun,
  AuditEntry,
  CheckpointDetails,
  CheckpointDiff,
  CommitRequest,
  Message,
  ParentAgentView,
  Project,
  ProjectDetail,
  ProjectMemberView,
  MemberSecurityView,
  RosterEntry,
  RunDetails,
  SystemInfo,
  TraceEvent,
  User,
} from "./types";

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

function branchUrl(url: string, branchId: string | null): string {
  return branchId ? url + "?branchId=" + encodeURIComponent(branchId) : url;
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
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    // Our handler puts the real text in `error`; Fastify's default puts a bare
    // status phrase in `error` and the real text in `message`.
    const detail =
      typeof data.message === "string" && data.message ? data.message : data.error;
    throw new ApiError(detail ?? "Request failed", response.status);
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
  getAgent: (id: string) => request<{ agent: Agent }>("/api/agents/" + id),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  upgradeAgentToProject: (id: string, projectName: string) =>
    request<{ project: Project; parentAgent: Agent; archivedWorkspace: string | null }>(
      "/api/agents/" + id + "/upgrade-to-project",
      {
        method: "POST",
        body: JSON.stringify({ projectName }),
      },
    ),
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
  messages: (id: string, branchId: string | null = null) =>
    request<{ messages: Message[] }>(branchUrl("/api/agents/" + id + "/messages", branchId)),
  runs: (id: string, branchId: string | null = null) =>
    request<{ runs: AgentRun[] }>(branchUrl("/api/agents/" + id + "/runs", branchId)),
  checkpoints: (id: string, branchId: string | null = null) =>
    request<{ checkpoints: AgentCheckpoint[] }>(branchUrl("/api/agents/" + id + "/checkpoints", branchId)),
  createCheckpoint: (id: string, label: string) =>
    request<{ checkpoint: AgentCheckpoint }>("/api/agents/" + id + "/checkpoints", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  branches: (id: string) =>
    request<{ branches: import("./types").AgentBranch[] }>("/api/agents/" + id + "/branches"),
  trace: (id: string, branchId: string | null = null) =>
    request<{ events: TraceEvent[] }>(branchUrl("/api/agents/" + id + "/trace", branchId)),
  checkpointDetails: (id: string) =>
    request<CheckpointDetails>("/api/checkpoints/" + id + "/details"),
  checkpointDiff: (id: string) =>
    request<{ diff: CheckpointDiff }>("/api/checkpoints/" + id + "/diff"),
  sendMessage: (id: string, content: string, branchId: string | null = null) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, branchId }),
      },
    ),
  createBranch: (id: string, checkpointId: string, name: string) =>
    request<{ branch: import("./types").AgentBranch }>("/api/agents/" + id + "/branches", {
      method: "POST",
      body: JSON.stringify({ checkpointId, name }),
    }),
  mergeBranches: (id: string, branchIds: string[]) =>
    request<{ mergedBranchIds: string[]; changedFiles: string[] }>(
      "/api/agents/" + id + "/branches/merge",
      { method: "POST", body: JSON.stringify({ branchIds }) },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runDetails: (id: string) => request<RunDetails>("/api/runs/" + id + "/details"),

  projects: {
    list: () => request<{ projects: Project[] }>("/api/projects"),
    create: (name: string) =>
      request<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    get: (id: string) => request<ProjectDetail>("/api/projects/" + id),
    delete: (id: string) =>
      request<{ archivedWorkspace: string | null; archivedSnapshots: number }>(
        "/api/projects/" + id,
        { method: "DELETE" },
      ),
    archive: (id: string) =>
      request<{ project: Project }>("/api/projects/" + id + "/archive", { method: "POST" }),
    unarchive: (id: string) =>
      request<{ project: Project }>("/api/projects/" + id + "/unarchive", { method: "POST" }),
    tree: (id: string) => request<{ files: string[] }>("/api/projects/" + id + "/tree"),
    file: (id: string, path: string) =>
      request<{ path: string; content: string }>(
        "/api/projects/" + id + "/file?path=" + encodeURIComponent(path),
      ),
    members: (id: string) =>
      request<{ members: ProjectMemberView[] | RosterEntry[] }>(
        "/api/projects/" + id + "/members",
      ),
    addMember: (id: string, body: { userName: string; role: string }) =>
      request<{ member: import("./types").ProjectMember }>("/api/projects/" + id + "/members", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateMember: (id: string, memberId: string, body: { role: string }) =>
      request<{ member: import("./types").ProjectMember }>(
        "/api/projects/" + id + "/members/" + memberId,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    removeMember: (id: string, memberId: string) =>
      request<{ ok: true }>("/api/projects/" + id + "/members/" + memberId, {
        method: "DELETE",
      }),
    parentAgent: (id: string) =>
      request<ParentAgentView>("/api/projects/" + id + "/parent-agent"),
    myAgent: (id: string) =>
      request<ParentAgentView>("/api/projects/" + id + "/my-agent"),
    securityAnalysis: (id: string, memberId: string) =>
      request<{ security: MemberSecurityView }>(
        "/api/projects/" + id + "/members/" + memberId + "/security-analysis",
        { method: "POST" },
      ),
    securityFix: (id: string, memberId: string, pointIds?: string[]) =>
      request<{ security: MemberSecurityView }>(
        "/api/projects/" + id + "/members/" + memberId + "/security-fix",
        { method: "POST", body: JSON.stringify(pointIds ? { pointIds } : {}) },
      ),
    submitCommitRequest: (
      id: string,
      memberId: string,
      body: { title?: string; note?: string },
    ) =>
      request<{ request: CommitRequest }>(
        "/api/projects/" + id + "/members/" + memberId + "/commit-request",
        { method: "POST", body: JSON.stringify(body) },
      ),
    commitRequests: (id: string) =>
      request<{ requests: CommitRequest[] }>("/api/projects/" + id + "/commit-requests"),
    decideCommitRequest: (requestId: string, decision: "approved" | "rejected") =>
      request<{ request: CommitRequest }>("/api/commit-requests/" + requestId + "/decide", {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
  },
  restoreCheckpoint: (id: string) =>
    request<{ checkpoint: AgentCheckpoint; workspacePath: string; workspaceHash: string }>("/api/checkpoints/" + id + "/restore", {
      method: "POST",
    }),
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
