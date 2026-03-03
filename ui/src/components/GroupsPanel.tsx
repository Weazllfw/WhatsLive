import { useState } from 'react';
import type { Device, Group } from '../types';
import { STATE_COLOURS, GROUP_COLORS } from '../types';

interface Props {
  groups:          Group[];
  devices:         Device[];
  onCreateGroup:   (name: string, color: string) => void;
  onDeleteGroup:   (id: number) => void;
}

function groupAggregateState(groupId: number, devices: Device[]): string {
  const members = devices.filter(d => d.group_id === groupId);
  if (members.length === 0) return STATE_COLOURS.unknown;
  if (members.some(d => d.state === 'down'))     return STATE_COLOURS.down;
  if (members.some(d => d.state === 'degraded')) return STATE_COLOURS.degraded;
  if (members.some(d => d.state === 'up'))       return STATE_COLOURS.up;
  return STATE_COLOURS.unknown;
}

export function GroupsPanel({ groups, devices, onCreateGroup, onDeleteGroup }: Props) {
  const [creating, setCreating] = useState(false);
  const [newName,  setNewName]  = useState('');
  const [newColor, setNewColor] = useState<string>(GROUP_COLORS[0]);

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    onCreateGroup(name, newColor);
    setNewName('');
    setNewColor(GROUP_COLORS[0]);
    setCreating(false);
  }

  return (
    <div className="groups-tab">
      {/* Toolbar */}
      <div className="groups-toolbar">
        {!creating ? (
          <button className="groups-new-btn" onClick={() => setCreating(true)}>
            + New Group
          </button>
        ) : (
          <div className="groups-create-form">
            <input
              className="groups-create-input"
              placeholder="Group name (e.g. VLAN1)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              autoFocus
            />
            <div className="groups-create-colors">
              {GROUP_COLORS.map(c => (
                <button
                  key={c}
                  className={`group-color-dot ${newColor === c ? 'group-color-dot--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>
            <div className="groups-create-actions">
              <button className="groups-create-submit" onClick={handleCreate} disabled={!newName.trim()}>
                Create
              </button>
              <button className="groups-create-cancel" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* List */}
      {groups.length === 0 && !creating && (
        <div className="groups-empty">
          No groups yet.<br />
          Create one to visually organise devices on the map.
        </div>
      )}

      {groups.map(g => {
        const members     = devices.filter(d => d.group_id === g.id);
        const stateColor  = groupAggregateState(g.id, devices);
        const downCount   = members.filter(d => d.state === 'down').length;
        const degradCount = members.filter(d => d.state === 'degraded').length;

        return (
          <div key={g.id} className="group-item">
            <span className="group-state-dot" style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}` }} />
            <span className="group-color-chip" style={{ background: g.color }} />
            <div className="group-item-info">
              <span className="group-item-name">{g.name}</span>
              <span className="group-item-meta">
                {members.length} device{members.length !== 1 ? 's' : ''}
                {downCount   > 0 && <span className="group-meta-down">  · {downCount} down</span>}
                {degradCount > 0 && <span className="group-meta-degraded">  · {degradCount} deg</span>}
              </span>
            </div>
            <button
              className="group-item-delete"
              onClick={() => onDeleteGroup(g.id)}
              title="Delete group (devices are kept)"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
