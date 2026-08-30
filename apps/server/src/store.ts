import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  users: [],
  audit: [],
  agents: [],
  projects: [],
  projectMembers: [],
  commitRequests: [],
  branches: [],
  messages: [],
  runs: [],
  traces: [],
  snapshots: [],
  contexts: [],
  checkpoints: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      parsed.users ??= [];
      parsed.audit ??= [];
      parsed.projects ??= [];
      parsed.projectMembers ??= [];
      parsed.commitRequests ??= [];
      parsed.traces ??= [];
      for (const member of parsed.projectMembers) {
        member.securityAnalysis ??= null;
        delete (member as { lastSecurityCheck?: unknown }).lastSecurityCheck;
      }
      for (const request of parsed.commitRequests) {
        request.securityAnalysis ??= null;
        delete (request as { securityCheck?: unknown }).securityCheck;
      }
      for (const project of parsed.projects) project.archivedAt ??= null;
      parsed.branches ??= [];
      parsed.snapshots ??= [];
      parsed.contexts ??= [];
      parsed.checkpoints ??= [];
      for (const run of parsed.runs) {
        run.branchId ??= null;
        run.beforeWorkspaceHash ??= null;
        run.afterWorkspaceHash ??= null;
        run.checkpointId ??= null;
      }
      for (const message of parsed.messages) message.branchId ??= null;
      for (const context of parsed.contexts) {
        context.sessionRolloutPath ??= null;
        context.sessionLineOffset ??= null;
      }
      for (const checkpoint of parsed.checkpoints) {
        checkpoint.branchId ??= null;
        checkpoint.label ??= null;
      }
      for (const event of parsed.traces) event.branchId ??= null;
      for (const agent of parsed.agents) {
        agent.ownerId ??= "";
        agent.projectId ??= null;
        agent.kind ??= "standalone";
        agent.memberId ??= null;
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
