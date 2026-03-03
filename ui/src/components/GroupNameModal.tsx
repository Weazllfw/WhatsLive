import { useState, useEffect, useRef } from 'react';

const GROUP_COLORS = [
  '#1e3a5c', '#1e4d3a', '#4d1e1e', '#3a1e4d',
  '#4d3a1e', '#1e3a4d', '#2d4a2d', '#4a2d2d',
];

interface Props {
  initial?: { name: string; color: string };
  title:    string;
  onSave:   (name: string, color: string) => void;
  onClose:  () => void;
}

export function GroupNameModal({ initial, title, onSave, onClose }: Props) {
  const [name,  setName]  = useState(initial?.name  ?? '');
  const [color, setColor] = useState(initial?.color ?? GROUP_COLORS[0]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  function handleSave() {
    if (!name.trim()) return;
    onSave(name.trim(), color);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 340 }}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <label className="modal-label">
            Group name
            <input
              ref={inputRef}
              className="modal-input"
              type="text"
              value={name}
              placeholder="e.g. Server Room"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            />
          </label>

          <label className="modal-label" style={{ marginTop: 14 }}>
            Colour
            <div className="color-swatch-row">
              {GROUP_COLORS.map(c => (
                <button
                  key={c}
                  className={`color-swatch ${color === c ? 'color-swatch--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={c}
                />
              ))}
            </div>
          </label>
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn--ghost" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn--primary" onClick={handleSave} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
