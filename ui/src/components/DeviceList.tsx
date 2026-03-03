import { useState, useMemo } from 'react';
import type { Device, DeviceState } from '../types';
import { STATE_COLOURS, DEVICE_TYPES, displayName } from '../types';

const STATE_ORDER: Record<DeviceState, number> = {
  down: 0, degraded: 1, unknown: 2, up: 3, ignored: 4,
};

const STATE_LABEL: Record<DeviceState, string> = {
  up: 'UP', down: 'DN', degraded: 'DG', unknown: '–', ignored: '–',
};

interface Props {
  devices:            Device[];
  selectedMAC:        string | null;
  showHidden:         boolean;
  onSelectDevice:     (mac: string) => void;
  onToggleShowHidden: () => void;
  onCreateDevice:     (label: string, ip: string, deviceType: string) => Promise<string | null>;
}

export function DeviceList({ devices, selectedMAC, showHidden, onSelectDevice, onToggleShowHidden, onCreateDevice }: Props) {
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<'state' | 'name' | 'ip'>('state');

  const [creating,  setCreating]  = useState(false);
  const [newLabel,  setNewLabel]  = useState('');
  const [newIP,     setNewIP]     = useState('');
  const [newType,   setNewType]   = useState('generic');
  const [saving,    setSaving]    = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setSaving(true);
    setCreateErr(null);
    const err = await onCreateDevice(newLabel.trim(), newIP.trim(), newType);
    setSaving(false);
    if (err) {
      setCreateErr(err);
    } else {
      setCreating(false);
      setNewLabel(''); setNewIP(''); setNewType('generic'); setCreateErr(null);
    }
  }

  function cancelCreate() {
    setCreating(false); setNewLabel(''); setNewIP(''); setNewType('generic'); setCreateErr(null);
  }

  function handleDragStart(e: React.DragEvent, mac: string) {
    e.dataTransfer.setData('device-mac', mac);
    e.dataTransfer.effectAllowed = 'move';
  }

  const hiddenCount = devices.filter(d => d.hidden).length;

  const sorted = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = showHidden ? devices : devices.filter(d => !d.hidden);
    const filtered = q
      ? base.filter(d =>
          displayName(d).toLowerCase().includes(q) ||
          d.ip.includes(q) ||
          (d.vendor ?? '').toLowerCase().includes(q)
        )
      : base;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'state') return STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (sortKey === 'name')  return displayName(a).localeCompare(displayName(b));
      return a.ip.localeCompare(b.ip, undefined, { numeric: true });
    });
  }, [devices, showHidden, filter, sortKey]);

  return (
    <div className="device-list">
      {/* Add device form / button */}
      {creating ? (
        <form className="dl-add-form" onSubmit={submitCreate}>
          <input
            className="dl-add-input"
            placeholder="Name *"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            autoFocus
            required
          />
          <input
            className="dl-add-input"
            placeholder="IP (optional)"
            value={newIP}
            onChange={e => setNewIP(e.target.value)}
          />
          <select
            className="dl-add-select"
            value={newType}
            onChange={e => setNewType(e.target.value)}
          >
            {DEVICE_TYPES.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          {createErr && <div className="dl-add-error">{createErr}</div>}
          <div className="dl-add-actions">
            <button className="dl-add-save" type="submit" disabled={saving || !newLabel.trim()}>
              {saving ? '…' : 'Add'}
            </button>
            <button className="dl-add-cancel" type="button" onClick={cancelCreate}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="dl-add-btn" onClick={() => setCreating(true)}>+ Add device</button>
      )}

      {/* Search + sort row */}
      <div className="dl-search-bar">
        <div className="dl-search-wrap">
          <span className="dl-search-icon">⌕</span>
          <input
            className="dl-search"
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          {filter && <button className="dl-search-clear" onClick={() => setFilter('')}>✕</button>}
        </div>
        <div className="dl-sort-pills">
          {(['state', 'name', 'ip'] as const).map(k => (
            <button
              key={k}
              className={`dl-pill ${sortKey === k ? 'dl-pill--on' : ''}`}
              onClick={() => setSortKey(k)}
            >
              {k}
            </button>
          ))}
          {hiddenCount > 0 && (
            <button
              className={`dl-pill dl-pill--ghost ${showHidden ? 'dl-pill--on' : ''}`}
              onClick={onToggleShowHidden}
              title={showHidden ? 'Hide hidden devices' : `Show ${hiddenCount} hidden`}
            >
              {showHidden ? 'hide' : `+${hiddenCount}`}
            </button>
          )}
        </div>
      </div>

      {/* Device cards */}
      <div className="dl-rows">
        {sorted.length === 0 && (
          <div className="dl-empty">
            {filter ? 'No devices match.' : 'No devices discovered yet.'}
          </div>
        )}

        {sorted.map(d => {
          const sc       = STATE_COLOURS[d.state] ?? STATE_COLOURS.unknown;
          const name     = displayName(d);
          const selected = selectedMAC === d.mac;

          return (
            <div
              key={d.mac}
              className={`dc ${selected ? 'dc--selected' : ''} ${d.hidden ? 'dc--hidden' : ''}`}
              onClick={() => onSelectDevice(d.mac)}
              draggable
              onDragStart={e => handleDragStart(e, d.mac)}
              style={{ '--sc': sc } as React.CSSProperties}
              title={`${name} · ${d.ip}${d.vendor ? ` · ${d.vendor}` : ''}`}
            >
              <span className="dc-bar" />
              <div className="dc-body">
                <div className="dc-name">
                  {name}
                  {d.is_custom && <span className="dc-custom-badge">custom</span>}
                </div>
                <div className="dc-sub">
                  {d.ip !== '0.0.0.0' && <span className="dc-ip">{d.ip}</span>}
                  {d.vendor && <><span className="dc-sep">·</span><span className="dc-vendor">{d.vendor}</span></>}
                </div>
              </div>
              <span className="dc-state" style={{ color: sc }}>
                {STATE_LABEL[d.state] ?? '–'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
