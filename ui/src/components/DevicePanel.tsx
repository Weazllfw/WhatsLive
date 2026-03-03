import { useState, useEffect } from 'react';
import type { Device, Group, ConnectionItem } from '../types';
import { STATE_COLOURS, DEVICE_TYPES, GROUP_COLORS, displayName } from '../types';

const DEVICE_TYPE_ICONS: Record<string, string> = {
  router:      '🔀',
  firewall:    '🛡️',
  switch:      '🔁',
  ap:          '📡',
  server:      '🖥️',
  nas:         '💾',
  printer:     '🖨️',
  workstation: '🖥️',
  laptop:      '💻',
  phone:       '📞',
  tv:          '📺',
  camera:      '📷',
  isp:         '🌐',
  cloud:       '☁️',
  generic:     '📦',
};

interface HistoryEntry {
  from_state: string;
  to_state:   string;
  at:         string;
}

interface Props {
  device:           Device | null;
  groups:           Group[];
  connections:      ConnectionItem[];
  showAutoEdges:    boolean;
  onBack:           () => void;
  onSave:           (mac: string, label: string, deviceType: string, ip?: string, notes?: string) => void;
  onToggleHidden:   (mac: string, hidden: boolean) => void;
  onDeleteDevice:   (mac: string) => void;
  onConnect:        (mac: string) => void;
  onAssignGroup:    (mac: string, groupId: number | null) => void;
  onCreateGroup:    (name: string, color: string) => Promise<Group | null>;
  onToggleAutoEdge:   (key: string, currentlyHidden: boolean) => void;
  onToggleCustomEdge: (id: number, currentlyHidden: boolean) => void;
  onDeleteEdge:       (id: number) => void;
  onShowAllEdges:     () => void;
}

function fmt(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return iso; }
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <span className={`detail-value ${mono ? 'mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

const STATE_ICON: Record<string, string> = {
  up:       '🟢',
  degraded: '🟡',
  down:     '🔴',
  unknown:  '⚪',
  ignored:  '⬛',
};

export function DevicePanel({
  device, groups, connections, showAutoEdges,
  onBack, onSave, onToggleHidden, onDeleteDevice, onConnect,
  onAssignGroup, onCreateGroup,
  onToggleAutoEdge, onToggleCustomEdge, onDeleteEdge, onShowAllEdges,
}: Props) {
  const [label,        setLabel]        = useState('');
  const [deviceType,   setDeviceType]   = useState('generic');
  const [ip,           setIP]           = useState('');
  const [notes,        setNotes]        = useState('');
  const [dirty,        setDirty]        = useState(false);
  const [creatingGrp,  setCreatingGrp]  = useState(false);
  const [newGrpName,   setNewGrpName]   = useState('');
  const [newGrpColor,  setNewGrpColor]  = useState<string>(GROUP_COLORS[0]);
  const [history,      setHistory]      = useState<HistoryEntry[]>([]);
  const [histExpanded, setHistExpanded] = useState(false);

  useEffect(() => {
    if (!device) return;
    setLabel(device.label ?? '');
    setDeviceType(device.device_type ?? 'generic');
    setIP(device.ip === '0.0.0.0' ? '' : (device.ip ?? ''));
    setNotes(device.notes ?? '');
    setDirty(false);
    setCreatingGrp(false);
    setHistory([]);
    setHistExpanded(false);
  }, [device?.mac]);

  useEffect(() => {
    if (!device || !histExpanded) return;
    fetch(`/api/devices/${encodeURIComponent(device.mac)}/history`)
      .then(r => r.json())
      .then((data: HistoryEntry[]) => setHistory(data))
      .catch(() => {});
  }, [device?.mac, histExpanded]);

  if (!device) return null;

  const colour      = STATE_COLOURS[device.state] ?? STATE_COLOURS.unknown;
  const icon        = DEVICE_TYPE_ICONS[deviceType] ?? DEVICE_TYPE_ICONS.generic;
  const autoConns   = connections.filter(c => c.kind === 'auto');
  const customConns = connections.filter(c => c.kind === 'custom');
  const hiddenCount = autoConns.filter(c => c.hidden).length;
  const currentGroup = groups.find(g => g.id === device.group_id);

  async function handleCreateAndAssign() {
    const name = newGrpName.trim();
    if (!name) return;
    const grp = await onCreateGroup(name, newGrpColor);
    if (grp && device) onAssignGroup(device.mac, grp.id);
    setCreatingGrp(false);
    setNewGrpName('');
  }

  return (
    <div className="device-panel">
      <button className="panel-back" onClick={onBack}>← Devices</button>

      <div className="panel-hero">
        <span className="panel-hero-icon">{icon}</span>
        <div className="panel-hero-info">
          <div className="panel-hero-name">{displayName(device)}</div>
          <div className="panel-hero-ip mono">{device.ip}</div>
        </div>
      </div>

      <div className="panel-state-strip" style={{ '--state-colour': colour } as React.CSSProperties}>
        <span className="panel-state-dot" />
        <span className="panel-state-text">{device.state.toUpperCase()}</span>
        {device.latency_ms != null && device.latency_ms > 0 && (
          <span className="panel-latency">{device.latency_ms} ms</span>
        )}
      </div>

      {/* ── Inline edit ─────────────────────────────────────────────── */}
      <div className="panel-edit">
        <div className="panel-field">
          <label className="panel-label">Display name</label>
          <input
            className="panel-input"
            placeholder={device.hostname || device.ip}
            value={label}
            onChange={e => { setLabel(e.target.value); setDirty(true); }}
          />
        </div>
        <div className="panel-field">
          <label className="panel-label">Device type</label>
          <select
            className="panel-select"
            value={deviceType}
            onChange={e => { setDeviceType(e.target.value); setDirty(true); }}
          >
            {DEVICE_TYPES.map(t => (
              <option key={t} value={t}>{DEVICE_TYPE_ICONS[t] ?? ''} {t}</option>
            ))}
          </select>
        </div>
        {device.is_custom && (
          <div className="panel-field">
            <label className="panel-label">IP address <span className="panel-label-hint">(for monitoring)</span></label>
            <input
              className="panel-input"
              placeholder="e.g. 192.168.1.10"
              value={ip}
              onChange={e => { setIP(e.target.value); setDirty(true); }}
            />
          </div>
        )}
        <div className="panel-field">
          <label className="panel-label">Notes</label>
          <textarea
            className="panel-textarea"
            placeholder="Port 4 on the switch, VLAN 10…"
            rows={3}
            value={notes}
            onChange={e => { setNotes(e.target.value); setDirty(true); }}
          />
        </div>
        {dirty && (
          <button className="panel-save-btn" onClick={() => {
            onSave(device.mac, label, deviceType, device.is_custom ? ip : undefined, notes);
            setDirty(false);
          }}>
            Save changes
          </button>
        )}
      </div>

      {/* ── Group assignment ─────────────────────────────────────────── */}
      <div className="panel-group-section">
        <label className="panel-label">Group</label>
        {!creatingGrp ? (
          <div className="panel-group-row">
            {currentGroup && (
              <span className="panel-group-chip" style={{ borderColor: currentGroup.color, color: currentGroup.color }}>
                {currentGroup.name}
              </span>
            )}
            <select
              className="panel-select"
              value={device.group_id ?? ''}
              onChange={e => {
                const val = e.target.value;
                if (val === '__new__') { setCreatingGrp(true); return; }
                onAssignGroup(device.mac, val ? parseInt(val, 10) : null);
              }}
            >
              <option value="">No group</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value="__new__">+ Create new group…</option>
            </select>
          </div>
        ) : (
          <div className="panel-group-create">
            <input
              className="panel-input"
              placeholder="Group name (e.g. VLAN1)"
              value={newGrpName}
              autoFocus
              onChange={e => setNewGrpName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateAndAssign(); if (e.key === 'Escape') setCreatingGrp(false); }}
            />
            <div className="groups-create-colors">
              {GROUP_COLORS.map(c => (
                <button
                  key={c}
                  className={`group-color-dot ${newGrpColor === c ? 'group-color-dot--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setNewGrpColor(c)}
                />
              ))}
            </div>
            <div className="groups-create-actions">
              <button className="groups-create-submit" onClick={handleCreateAndAssign} disabled={!newGrpName.trim()}>
                Create &amp; assign
              </button>
              <button className="groups-create-cancel" onClick={() => setCreatingGrp(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Connections ─────────────────────────────────────────────── */}
      <div className="conn-section">
        <div className="conn-header">
          <span>Connections</span>
          {hiddenCount > 0 && (
            <button className="conn-restore-btn" onClick={onShowAllEdges}>Restore {hiddenCount} hidden</button>
          )}
        </div>

        {connections.length === 0 && <div className="conn-empty">No connections detected</div>}
        {!showAutoEdges && autoConns.length > 0 && <div className="conn-empty">Auto-lines hidden (⌁ in map controls)</div>}

        {showAutoEdges && autoConns.map(c => (
          <div key={c.edgeKey} className={`conn-item ${c.hidden ? 'conn-item--hidden' : ''}`}>
            <span className="conn-dot conn-dot--auto" />
            <span className="conn-name">{c.otherName}</span>
            <button
              className={`conn-btn ${c.hidden ? 'conn-btn--show' : ''}`}
              onClick={() => onToggleAutoEdge(c.edgeKey!, c.hidden ?? false)}
              title={c.hidden ? 'Show line' : 'Hide line'}
            >
              {c.hidden ? '👁' : '🙈'}
            </button>
          </div>
        ))}

        {customConns.map(c => (
          <div key={c.edgeId} className={`conn-item conn-item--custom ${c.hidden ? 'conn-item--hidden' : ''}`}>
            <span className="conn-dot conn-dot--custom" />
            <span className="conn-name">{c.otherName}</span>
            {c.edgeLabel && <span className="conn-label-badge">{c.edgeLabel}</span>}
            <button
              className={`conn-btn ${c.hidden ? 'conn-btn--show' : ''}`}
              onClick={() => onToggleCustomEdge(c.edgeId!, c.hidden ?? false)}
              title={c.hidden ? 'Show line' : 'Hide line'}
            >
              {c.hidden ? '👁' : '🙈'}
            </button>
            <button
              className="conn-btn conn-btn--delete"
              onClick={() => onDeleteEdge(c.edgeId!)}
              title="Delete connection permanently"
            >
              🗑
            </button>
          </div>
        ))}

        <button className="panel-action-btn conn-add-btn" onClick={() => onConnect(device.mac)}>
          + Connect to another device…
        </button>
      </div>

      {/* ── Visibility / actions ─────────────────────────────────────── */}
      <div className="panel-actions">
        <button
          className={`panel-action-btn ${device.hidden ? 'panel-action-btn--warning' : ''}`}
          onClick={() => onToggleHidden(device.mac, !device.hidden)}
        >
          {device.hidden ? '👁 Show on map' : '🙈 Hide from map'}
        </button>
        {device.is_custom && (
          <button
            className="panel-action-btn panel-action-btn--danger"
            onClick={() => {
              if (window.confirm(`Delete "${displayName(device)}"? This cannot be undone.`)) {
                onDeleteDevice(device.mac);
              }
            }}
          >
            🗑 Delete device
          </button>
        )}
      </div>

      {/* ── Details ─────────────────────────────────────────────────── */}
      <div className="panel-details">
        <Row label="MAC"        value={device.mac}           mono />
        <Row label="Hostname"   value={device.hostname} />
        <Row label="Vendor"     value={device.vendor} />
        <Row label="First seen" value={fmt(device.first_seen)} />
        <Row label="Last seen"  value={fmt(device.last_seen)} />
      </div>

      {/* ── State history ────────────────────────────────────────────── */}
      <div className="panel-history">
        <button
          className="panel-history-toggle"
          onClick={() => setHistExpanded(p => !p)}
        >
          {histExpanded ? '▾' : '▸'} Event history
        </button>
        {histExpanded && (
          <div className="panel-history-list">
            {history.length === 0
              ? <div className="panel-history-empty">No state changes recorded yet</div>
              : history.map((e, i) => (
                  <div key={i} className="panel-history-row">
                    <span className="panel-history-icon">{STATE_ICON[e.to_state] ?? '⚪'}</span>
                    <span className="panel-history-states">
                      <span className={`ph-state ph-state--${e.from_state}`}>{e.from_state}</span>
                      <span className="ph-arrow">→</span>
                      <span className={`ph-state ph-state--${e.to_state}`}>{e.to_state}</span>
                    </span>
                    <span className="panel-history-time">{fmt(e.at)}</span>
                  </div>
                ))
            }
          </div>
        )}
      </div>
    </div>
  );
}
