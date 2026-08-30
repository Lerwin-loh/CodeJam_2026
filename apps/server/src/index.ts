import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { ProjectService } from "./project-service.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { createIsolatedMergeAiResolver, MergeEngine } from "./merge-engine.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const history = new WorkspaceHistory(path.join(config.dataDirectory, "branchpoint"));
const runner = createRunner(config);
const mergeEngine = new MergeEngine(history, createIsolatedMergeAiResolver(runner));
const projects = new ProjectService(store, workspaces, history, mergeEngine, config.codexHome);
const service = new AgentService(config, store, workspaces, runner, history, mergeEngine);
await service.initialize();

const app = await createApp(config, service, projects);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
