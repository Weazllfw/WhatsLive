import { useEffect, useRef } from 'react';
import type { Device, Group } from '../types';

export type CtxTarget =
  | { kind: 'node';       device: Device }
  | { kind: 'edge';       edgeId: number; sourceName: string; targetName: string }
  | { kind: 'canvas';     x: number; y: number }   // map coords for group placement
  | { kind: 'group';      group: Group };

interface Props {
  target:   CtxTarget;
  x:        number;   // viewport px from left of map container
  y:        number;   // viewport px from top of map container
  groups:   Group[];
  onClose:  () => void;
  // node actions
  onEditDevice:      (mac: string)   => void;
  onConnectDevice:   (mac: string)   => void;
  onToggleHidden:    (mac: string, hidden: boolean) => void;
  onAssignGroup:     (mac: string, groupId: number | null) => void;
  // edge actions
  onDeleteEdge:      (id: number)    => void;
  // canvas actions
  onCreateGroup:     (mapX: number, mapY: number) => void;
  // group actions
  onRenameGroup:     (id: number)    => void;
  onDeleteGroup:     (id: number)    => void;
}

export function ContextMenu({
  target, x, y, groups, onClose,
  onEditDevice, onConnectDevice, onToggleHidden, onAssignGroup,
  onDeleteEdge, onCreateGroup, onRenameGroup, onDeleteGroup,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    function handler(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') onClose();
        return;
      }
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  // Keep menu inside the map container
  const style: React.CSSProperties = {
    position: 'absolute',
    left: x,
    top:  y,
    zIndex: 50,
  };

  function Item({ label, icon, onClick, danger }: {
    label: string; icon?: string; onClick: () => void; danger?: boolean;
  }) {
    return (
      <button
        className={`ctx-item ${danger ? 'ctx-item--danger' : ''}`}
        onClick={() => { onClick(); onClose(); }}
      >
        {icon && <span className="ctx-icon">{icon}</span>}
        {label}
      </button>
    );
  }

  function Sep() { return <div className="ctx-sep" />; }

  return (
    <div ref={ref} className="ctx-menu" style={style} onContextMenu={e => e.preventDefault()}>
      {target.kind === 'node' && (() => {
        const d = target.device;
        return (
          <>
            <div className="ctx-header">{d.label || d.hostname || d.ip}</div>
            <Item icon="✏️" label="Edit device…"        onClick={() => onEditDevice(d.mac)} />
            <Item icon="🔗" label="Connect to…"         onClick={() => onConnectDevice(d.mac)} />
            <Sep />
            {groups.length > 0 && (
              <>
                <div className="ctx-sub-label">Move to group</div>
                {groups.map(g => (
                  <Item
                    key={g.id}
                    label={g.name}
                    icon={d.group_id === g.id ? '✓' : '  '}
                    onClick={() => onAssignGroup(d.mac, d.group_id === g.id ? null : g.id)}
                  />
                ))}
                {d.group_id != null && (
                  <Item label="Remove from group" icon="✕" onClick={() => onAssignGroup(d.mac, null)} />
                )}
                <Sep />
              </>
            )}
            <Item
              icon={d.hidden ? '👁' : '🙈'}
              label={d.hidden ? 'Show on map' : 'Hide from map'}
              onClick={() => onToggleHidden(d.mac, !d.hidden)}
            />
          </>
        );
      })()}

      {target.kind === 'edge' && (
        <>
          <div className="ctx-header">Connection</div>
          <div className="ctx-info">{target.sourceName} → {target.targetName}</div>
          <Item icon="🗑" label="Delete connection" danger onClick={() => onDeleteEdge(target.edgeId)} />
        </>
      )}

      {target.kind === 'canvas' && (
        <>
          <Item icon="▭" label="Create group here…" onClick={() => onCreateGroup(target.x, target.y)} />
        </>
      )}

      {target.kind === 'group' && (
        <>
          <div className="ctx-header">{target.group.name}</div>
          <Item icon="✏️" label="Rename group…" onClick={() => onRenameGroup(target.group.id)} />
          <Sep />
          <Item icon="🗑" label="Delete group"  danger onClick={() => onDeleteGroup(target.group.id)} />
        </>
      )}
    </div>
  );
}
