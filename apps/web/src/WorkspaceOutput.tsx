import { api } from "./api";
import type { AgentBranch, WorkspacePreview } from "./types";

export interface WorkspaceOutputProps {
  agentId: string;
  agentName: string;
  activeBranchId: string | null;
  branches: AgentBranch[];
  workspacePreview: WorkspacePreview | null;
  previewReload: number;
  previewError: boolean;
  previewExpanded: boolean;
  onBranchChange: (branchId: string | null) => void;
  onRefresh: () => void;
  onError: () => void;
  onExpand: () => void;
  onClose: () => void;
}

/** Workspace output is intentionally independent from the agent conversation. */
export function WorkspaceOutput({
  agentId,
  agentName,
  activeBranchId,
  branches,
  workspacePreview,
  previewReload,
  previewError,
  previewExpanded,
  onBranchChange,
  onRefresh,
  onError,
  onExpand,
  onClose,
}: WorkspaceOutputProps) {
  // Keep the workspace output out of the layout until this workspace has a
  // real HTML entry point (including a built app discovered by the server).
  if (!workspacePreview?.available || !workspacePreview.entryFile) return null;

  const previewUrl = workspacePreview?.entryFile
    ? api.previewUrl(agentId, workspacePreview.entryFile, activeBranchId) + "&v=" + previewReload
    : null;
  const sourceKey = [
    agentId,
    activeBranchId ?? "main",
    workspacePreview?.entryFile ?? "none",
    workspacePreview?.workspaceHash ?? "none",
  ].join(":");

  const branchSelector = (
    <select
      className="preview-branch-select"
      value={activeBranchId ?? "main"}
      onChange={(event) => onBranchChange(event.target.value === "main" ? null : event.target.value)}
      aria-label="Preview workspace"
    >
      <option value="main">Main workspace</option>
      {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
    </select>
  );

  const controls = (
    <div className="live-preview-actions">
      {branches.length > 0 && branchSelector}
      <button className="button button-ghost" type="button" onClick={onRefresh}>Refresh</button>
      <button className="button button-ghost preview-expand-button" type="button" onClick={onExpand} aria-label="Expand website preview">
        <span aria-hidden="true">↗</span> <span>Expand</span>
      </button>
    </div>
  );

  const body = workspacePreview?.available && previewUrl && !previewError
    ? <iframe key={sourceKey + ":" + previewReload} className="live-preview-frame" title="Generated website preview" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms" onError={onError} />
    : <div className="live-preview-empty"><strong>{previewError ? "Preview could not be loaded" : "No website preview yet"}</strong><span>{previewError ? "Refresh the preview or ask the Agent to check the website entry file." : "Ask the Agent to create a website. The preview automatically discovers HTML pages and built web apps."}</span></div>;

  return (
    <>
      {!previewExpanded && (
        <section className="live-preview-card" aria-label="Live website preview">
          <div className="live-preview-heading">
            <div>
              <span className="eyebrow">Workspace output</span>
              <h2>Live website preview</h2>
            </div>
            {workspacePreview?.available && controls}
          </div>
          {body}
        </section>
      )}
      {previewExpanded && workspacePreview?.available && previewUrl && !previewError && (
        <div className="preview-expanded-backdrop" role="dialog" aria-modal="true" aria-label="Expanded website preview">
          <section className="preview-expanded-panel">
            <header className="preview-expanded-heading">
              <div>
                <span className="eyebrow">Workspace output</span>
                <h2>{agentName} · Live preview</h2>
              </div>
              <div className="live-preview-actions">
                {branches.length > 0 && (
                  <select
                    className="preview-branch-select"
                    value={activeBranchId ?? "main"}
                    onChange={(event) => {
                      onClose();
                      onBranchChange(event.target.value === "main" ? null : event.target.value);
                    }}
                    aria-label="Preview workspace"
                  >
                    <option value="main">Main workspace</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                )}
                <button className="button button-ghost" type="button" onClick={onRefresh}>Refresh</button>
                <button className="button button-ghost" type="button" onClick={onClose} aria-label="Close expanded website preview">× Close</button>
              </div>
            </header>
            <iframe key={sourceKey + ":" + previewReload + ":expanded"} className="live-preview-frame live-preview-frame-expanded" title="Expanded generated website preview" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms" onError={() => { onError(); onClose(); }} />
          </section>
        </div>
      )}
    </>
  );
}
