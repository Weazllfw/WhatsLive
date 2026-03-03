import { useState, useEffect, useRef } from 'react';
import type { Device } from '../types';
import { DEVICE_TYPES } from '../types';

const TYPE_LABELS: Record<string, string> = {
  router:  'Router / Gateway',
  switch:  'Network Switch',
  server:  'Server',
  ap:      'Access Point',
  nas:     'NAS / Storage',
  printer: 'Printer',
  generic: 'Generic Device',
};

interface Props {
  device:   Device;
  onSave:   (mac: string, label: string, deviceType: string) => void;
  onClose:  () => void;
}

export function EditDeviceModal({ device, onSave, onClose }: Props) {
  const [label, setLabel]       = useState(device.label);
  const [dtype, setDtype]       = useState(device.device_type);
  const [saving, setSaving]     = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSave() {
    setSaving(true);
    await onSave(device.mac, label, dtype);
    setSaving(false);
    onClose();
  }

  const autoName = (() => {
    if (!device.hostname) return device.ip;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(device.hostname)) return device.ip;
    return device.hostname.split('.')[0];
  })();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <span className="modal-title">Edit device</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <label className="modal-label">
            Display name
            <input
              ref={inputRef}
              className="modal-input"
              type="text"
              value={label}
              placeholder={autoName}
              onChange={e => setLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            />
            <span className="modal-hint">
              Leave blank to use auto-detected name ({autoName})
            </span>
          </label>

          <label className="modal-label" style={{ marginTop: 16 }}>
            Device type
            <select
              className="modal-select"
              value={dtype}
              onChange={e => setDtype(e.target.value)}
            >
              {DEVICE_TYPES.map(t => (
                <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
              ))}
            </select>
          </label>

          <div className="modal-info">
            <span className="modal-info-row"><b>IP:</b> {device.ip}</span>
            <span className="modal-info-row"><b>MAC:</b> {device.mac}</span>
            {device.vendor && <span className="modal-info-row"><b>Vendor:</b> {device.vendor}</span>}
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn--ghost" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
