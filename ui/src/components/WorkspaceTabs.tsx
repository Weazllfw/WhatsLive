import { useState, useRef, useEffect } from 'react';
import type { Workspace, Group } from '../types';

interface Props {
  workspaces:   Workspace[];
  activeId:     number;
  groups:       Group[];
  onSwitch:     (id: number) => void;
  onCreate:     (name: string, groupId: number | null) => Promise<Workspace | null>;
  onRename:     (id: number, name: string) => void;
  onDelete:     (id: number) => void;
  onGoToOverview: () => void;
}

export function WorkspaceTabs({
  workspaces, activeId, groups, onSwitch, onCreate, onRename, onDelete, onGoToOverview,
}: Props) {
  const isOnOverview = activeId === 1;
  const [creating,    setCreating]    = useState(false);
  const [newName,     setNewName]     = useState('');
  const [newGroupId,  setNewGroupId]  = useState<number | null>(null);
  const [saving,      setSaving]      = useState(false);

  // Inline rename state
  const [renamingId,  setRenamingId]  = useState<number | null>(null);
  const [renameVal,   setRenameVal]   = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.select();
  }, [renamingId]);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    await onCreate(newName.trim(), newGroupId);
    setSaving(false);
    setCreating(false);
    setNewName('');
    setNewGroupId(null);
  }

  function startRename(ws: Workspace) {
    setRenamingId(ws.id);
    setRenameVal(ws.name);
  }

  function commitRename(id: number) {
    const trimmed = renameVal.trim();
    if (trimmed) onRename(id, trimmed);
    setRenamingId(null);
  }

  function groupColor(groupId: number | null): string | null {
    if (groupId === null) return null;
    return groups.find(g => g.id === groupId)?.color ?? null;
  }

  return (
    <div className="ws-tab-bar">
      {/* Breadcrumb back button when inside a sub-workspace */}
      {!isOnOverview && (
        <button
          className="ws-back-crumb"
          onClick={onGoToOverview}
          title="Back to Overview"
        >
          ← Overview
        </button>
      )}

      {workspaces.map(ws => {
        const isActive  = ws.id === activeId;
        const isOverview = ws.id === 1;
        const dotColor  = groupColor(ws.group_id);
        const isRenaming = renamingId === ws.id;

        return (
          <div
            key={ws.id}
            className={`ws-tab ${isActive ? 'ws-tab--active' : ''}`}
            onClick={() => { if (!isRenaming) onSwitch(ws.id); }}
            onDoubleClick={() => startRename(ws)}
            title={isOverview ? 'Overview (all devices)' : ws.group_id ? `Linked to group ${groups.find(g => g.id === ws.group_id)?.name ?? ws.group_id}` : ws.name}
          >
            {dotColor && <span className="ws-tab-dot" style={{ background: dotColor }} />}

            {isRenaming ? (
              <input
                ref={renameInputRef}
                className="ws-tab-rename"
                value={renameVal}
                onChange={e => setRenameVal(e.target.value)}
                onBlur={() => commitRename(ws.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter')  { e.preventDefault(); commitRename(ws.id); }
                  if (e.key === 'Escape') { setRenamingId(null); }
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="ws-tab-name">{ws.name}</span>
            )}

            {!isOverview && !isRenaming && isActive && (
              <button
                className="ws-tab-close"
                onClick={e => { e.stopPropagation(); onDelete(ws.id); }}
                title="Delete workspace"
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {/* Create new workspace */}
      {creating ? (
        <form className="ws-create-form" onSubmit={submitCreate}>
          <input
            className="ws-create-input"
            placeholder="Workspace name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            autoFocus
            required
          />
          {groups.length > 0 && (
            <select
              className="ws-create-select"
              value={newGroupId ?? ''}
              onChange={e => setNewGroupId(e.target.value ? parseInt(e.target.value, 10) : null)}
            >
              <option value="">All devices</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <button className="ws-create-save" type="submit" disabled={saving || !newName.trim()}>
            {saving ? '…' : 'Add'}
          </button>
          <button
            className="ws-create-cancel"
            type="button"
            onClick={() => { setCreating(false); setNewName(''); setNewGroupId(null); }}
          >
            ✕
          </button>
        </form>
      ) : (
        <button className="ws-add-btn" onClick={() => setCreating(true)} title="New workspace">
          +
        </button>
      )}
    </div>
  );
}
