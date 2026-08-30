import type { TraceEvent } from "./types";

const LEGACY_GENERIC_EXPLANATION = "Codex reported an observable tool or model activity.";

function readable(value: string): string {
  const words = value.replace(/[._-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Activity";
}

function shortText(value: unknown, limit = 500): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, limit) : "";
}

export function traceEventLabel(event: TraceEvent): string {
  if (event.type !== "codex.event") return readable(event.type);
  const eventType = typeof event.metadata.eventType === "string" ? event.metadata.eventType : "activity";
  if (eventType === "error") return "Codex activity issue";
  if (eventType === "agent_message") return "Agent response";
  return readable(eventType);
}

export function traceEventDescription(event: TraceEvent): string {
  const explanation = shortText(event.metadata.explanation);
  if (explanation && explanation !== LEGACY_GENERIC_EXPLANATION) return explanation;
  if (event.type !== "codex.event") return explanation || "Recorded BranchPoint activity.";

  const eventType = typeof event.metadata.eventType === "string" ? event.metadata.eventType : "activity";
  const command = shortText(event.metadata.command, 240);
  const message = shortText(event.metadata.message);
  const output = eventType === "reasoning" ? "" : shortText(event.metadata.output);
  const completed = event.metadata.codexType === "item.completed";

  if (eventType === "command_execution") {
    if (!completed || event.metadata.status === "in_progress") {
      return command ? `Codex started running: ${command}` : "Codex started running a command.";
    }
    if (typeof event.metadata.exit_code === "number") {
      return command
        ? `Command finished with exit code ${event.metadata.exit_code}: ${command}`
        : `A command finished with exit code ${event.metadata.exit_code}.`;
    }
    return command ? `Codex finished running: ${command}` : "Codex finished running a command.";
  }
  if (eventType === "reasoning") {
    return completed
      ? "Codex completed a reasoning step; private reasoning content is not included in the trace."
      : "Codex started a reasoning step; private reasoning content is not included in the trace.";
  }
  if (eventType === "agent_message") return "Codex prepared an Agent response.";
  if (eventType === "file_change") {
    return completed ? "Codex completed a workspace file change." : "Codex started a workspace file change.";
  }
  if (eventType === "error") {
    return message || output
      ? `Codex reported an activity-level issue: ${message || output}`
      : "Codex reported an activity-level issue. The Run is marked failed separately if it cannot recover.";
  }
  return `Codex reported observable ${readable(eventType).toLowerCase()} activity.`;
}
