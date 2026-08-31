import { useState } from "react";
import type { MergeCombinedDecision, MergePreview } from "./types";

type WorkspaceChoice = "target" | "source" | "ai" | "combined";
type ContextChoice = "target" | "source" | "ai" | "combined";

interface AiResolution {
  context: Record<string, "target" | "source" | "combined">;
  workspace: Record<string, "target" | "source" | "combined">;
  combined: Record<string, MergeCombinedDecision>;
  aiDecisions: Record<string, string>;
}
interface Props {
  preview: MergePreview;
  busy?: boolean;
  onCancel: () => void;
  onFixWithAi: () => Promise<AiResolution>;
  onMerge: (resolution: {
    workspace: Record<string, WorkspaceChoice>;
    context: Record<string, ContextChoice>;
    combined: Record<string, MergeCombinedDecision>;
  }) => void;
}

function commitsForConflict(conflict: MergePreview["contextConflicts"][number], side: "target" | "source") {
  return side === "target" ? conflict.targetCommits ?? [conflict.target] : conflict.sourceCommits ?? [conflict.source];
}

export function MergeReview({ preview, busy = false, onCancel, onFixWithAi, onMerge }: Props) {
  const [workspace, setWorkspace] = useState<Record<string, WorkspaceChoice>>(() =>
    Object.fromEntries(preview.workspaceConflicts.map((item) => [item.path, "ai"] as const)),
  );
  const [combined, setCombined] = useState<Record<string, MergeCombinedDecision>>({});
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResolved, setAiResolved] = useState<Set<string>>(new Set());
  const [aiDecisions, setAiDecisions] = useState<Record<string, { choice: "target" | "source" | "combined"; explanation: string }>>({});

  const updateAiResults = (resolved: AiResolution, conflictKey?: string) => {
    const paths = conflictKey?.startsWith("workspace:")
      ? [conflictKey.slice("workspace:".length)]
      : preview.workspaceConflicts.map((item) => item.path);
    setWorkspace((current) => {
      const next = { ...current };
      for (const path of paths) {
        const choice = resolved.workspace[path];
        if (choice) next[path] = choice;
      }
      return next;
    });
    setCombined((current) => {
      const next = { ...current };
      for (const path of paths) {
        const decision = resolved.combined[path];
        if (decision) next[path] = decision;
      }
      return next;
    });
    setAiResolved((current) => new Set([
      ...current,
      ...paths.map((path) => "workspace:" + path),
    ]));
    setAiDecisions((current) => {
      const next = { ...current };
      for (const path of paths) {
        const choice = resolved.workspace[path];
        if (choice) {
          next["workspace:" + path] = {
            choice,
            explanation: resolved.aiDecisions["workspace:" + path] ?? (
              choice === "combined"
                ? "AI combined compatible code from both implementations."
                : "AI selected this implementation based on the complete merge criteria."
            ),
          };
        }
      }
      return next;
    });
  };

  const fixWithAi = async (conflictKey?: string) => {
    setAiBusy(conflictKey ?? "all");
    setAiError(null);
    try {
      updateAiResults(await onFixWithAi(), conflictKey);
    } catch (reason) {
      setAiError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAiBusy(null);
    }
  };

  const resolution = {
    workspace,
    context: Object.fromEntries(preview.contextConflicts.map((item) => [item.id, "ai" as const])),
    combined,
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section className="modal checkpoint-overlay merge-overlay" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><span className="eyebrow">Strict merge review</span><h2>Combine both outcomes</h2></div>
          <button type="button" onClick={onCancel}>×</button>
        </div>

        <div className="merge-outcomes">
          <article className="merge-outcome-card target"><span className="merge-card-kicker">TARGET · MAIN</span><h3>{preview.target.label}</h3><p className="merge-summary">{preview.target.summary}</p><ul className="merge-outcome-details">{preview.target.details.slice(1).map((item) => <li key={item}>{item}</li>)}</ul></article>
          <article className="merge-outcome-card source"><span className="merge-card-kicker">SOURCE · BRANCH</span><h3>{preview.source.label}</h3><p className="merge-summary">{preview.source.summary}</p><ul className="merge-outcome-details">{preview.source.details.slice(1).map((item) => <li key={item}>{item}</li>)}</ul></article>
        </div>

        <section className="merge-criteria"><div><span className="merge-card-kicker">MERGE CONTRACT</span><h3>Combined acceptance criteria</h3></div><ul>{preview.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul></section>

        {preview.combinedFiles.length > 0 && (
          <section className="merge-section">
            <div><span className="merge-card-kicker">AUTOMATICALLY COMBINED</span><h3>Compatible code from both sides</h3><p className="inspection-muted">These files merge cleanly, so both implementations will remain in the result.</p></div>
            {preview.combinedFiles.map((item) => (
              <div className="merge-provenance-card" key={item.path}>
                <strong className="merge-file-path">{item.path}</strong>
                <div className="merge-provenance-columns">
                  <div><b>Target prompts</b>{item.targetPrompts.length ? item.targetPrompts.map((commit) => <p key={commit.id}>{commit.prompt}</p>) : <p className="inspection-muted">No attributed prompt</p>}</div>
                  <div><b>Source prompts</b>{item.sourcePrompts.length ? item.sourcePrompts.map((commit) => <p key={commit.id}>{commit.prompt}</p>) : <p className="inspection-muted">No attributed prompt</p>}</div>
                </div>
                <small>Merge instruction: Combine the non-conflicting changes from both implementations.</small>
              </div>
            ))}
          </section>
        )}

        {Object.keys(aiDecisions).length > 0 && (
          <section className="merge-ai-results"><span className="merge-card-kicker">AI REVIEW RESULT</span><h3>What AI changed</h3><ul>{Object.entries(aiDecisions).map(([key, decision]) => <li key={key}><span>{key.replace("workspace:", "")}</span><div><strong>{decision.choice === "target" ? "Kept target/main" : decision.choice === "source" ? "Kept source/branch" : "Combined both implementations"}</strong><small>{decision.explanation}</small></div></li>)}</ul></section>
        )}

        {preview.workspaceConflicts.filter((item) => !aiResolved.has("workspace:" + item.path)).length > 0 && (
          <section className="merge-section">
            <div><span className="merge-card-kicker">NEEDS DECISION</span><h3>Code conflicts</h3><p className="inspection-muted">Prompt provenance follows the code decision. Keep one implementation, or let AI produce a validated combined file.</p></div>
            {preview.workspaceConflicts.filter((item) => !aiResolved.has("workspace:" + item.path)).map((item) => {
              const linked = preview.contextConflicts.filter((conflict) =>
                conflict.paths.includes(item.path) ||
                (item.path.startsWith("semantic:") && conflict.paths.some((path) => (item.targetPaths ?? []).includes(path) || (item.sourcePaths ?? []).includes(path))),
              );
              return (
                <div className="merge-conflict-choice" key={item.path}>
                  <span className="merge-file-path">{item.path}</span>
                  <select value={workspace[item.path] ?? "ai"} onChange={(event) => setWorkspace((current) => ({ ...current, [item.path]: event.target.value as WorkspaceChoice }))}>
                    <option value="ai">✦ Fix with AI</option>
                    <option value="target">Keep target/main</option>
                    <option value="source">Keep source/branch</option>
                  </select>
                  <button className="button button-ghost" type="button" disabled={aiBusy !== null} onClick={() => void fixWithAi("workspace:" + item.path)}>{aiBusy === "workspace:" + item.path ? "AI is reviewing…" : "✦ Fix with AI"}</button>
                  {linked.length > 0 && <div className="merge-linked-prompts">{linked.map((conflict) => <div className="merge-provenance-card" key={conflict.id}><div className="merge-provenance-columns"><div><b>Target prompts</b>{commitsForConflict(conflict, "target").map((commit) => <p key={commit.id}>{commit.prompt}</p>)}</div><div><b>Source prompts</b>{commitsForConflict(conflict, "source").map((commit) => <p key={commit.id}>{commit.prompt}</p>)}</div></div></div>)}</div>}
                </div>
              );
            })}
          </section>
        )}

        {aiError && <p className="form-error">AI resolution failed: {aiError}</p>}
        <div className="modal-actions">
          <button className="button button-ghost" type="button" disabled={busy || aiBusy !== null} onClick={onCancel}>Cancel</button>
          <button className="button button-secondary" type="button" disabled={busy || aiBusy !== null} onClick={() => void fixWithAi()}>{aiBusy === "all" ? <><span className="spinner" /> AI is reviewing…</> : "✦ Fix all with AI"}</button>
          <button className="button button-primary" type="button" disabled={busy || aiBusy !== null} onClick={() => onMerge(resolution)}>{busy ? <><span className="spinner" /> Merging…</> : "Merge"}</button>
        </div>
      </section>
    </div>
  );
}
