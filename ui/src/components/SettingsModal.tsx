import { useState, useEffect, useCallback } from 'react';
import type { LicenseInfo, NotificationSettings } from '../types';

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const [tab, setTab] = useState<'license' | 'notifications'>('license');

  // ── License ──────────────────────────────────────────────────────────────
  const [licInfo,  setLicInfo]  = useState<LicenseInfo | null>(null);
  const [licKey,   setLicKey]   = useState('');
  const [licMsg,   setLicMsg]   = useState<{ ok: boolean; text: string } | null>(null);
  const [licBusy,  setLicBusy]  = useState(false);

  const loadLicense = useCallback(async () => {
    try {
      const res = await fetch('/api/license');
      if (res.ok) setLicInfo(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadLicense(); }, [loadLicense]);

  async function applyLicense() {
    if (!licKey.trim()) return;
    setLicBusy(true);
    setLicMsg(null);
    try {
      const res = await fetch('/api/license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: licKey.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setLicMsg({ ok: true, text: `Activated — ${data.tier} tier` });
        setLicKey('');
        loadLicense();
      } else {
        setLicMsg({ ok: false, text: data.error ?? 'Unknown error' });
      }
    } catch (e: any) {
      setLicMsg({ ok: false, text: e.message });
    } finally {
      setLicBusy(false);
    }
  }

  async function clearLicense() {
    await fetch('/api/license', { method: 'DELETE' });
    setLicMsg({ ok: true, text: 'License removed — reverted to free tier' });
    loadLicense();
  }

  // ── Notifications ────────────────────────────────────────────────────────
  const [notif,     setNotif]     = useState<NotificationSettings>({ webhook_url: '', slack_webhook_url: '' });
  const [notifMsg,  setNotifMsg]  = useState<{ ok: boolean; text: string } | null>(null);
  const [notifBusy, setNotifBusy] = useState(false);

  useEffect(() => {
    fetch('/api/notifications')
      .then(r => r.json())
      .then(d => setNotif({ webhook_url: d.webhook_url ?? '', slack_webhook_url: d.slack_webhook_url ?? '' }))
      .catch(() => {});
  }, []);

  async function saveNotifications() {
    setNotifBusy(true);
    setNotifMsg(null);
    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notif),
      });
      if (res.ok) setNotifMsg({ ok: true, text: 'Saved' });
      else setNotifMsg({ ok: false, text: 'Save failed' });
    } catch (e: any) {
      setNotifMsg({ ok: false, text: e.message });
    } finally {
      setNotifBusy(false);
    }
  }

  async function testNotification() {
    setNotifBusy(true);
    setNotifMsg(null);
    try {
      const res = await fetch('/api/notifications/test', { method: 'POST' });
      const data = await res.json();
      if (res.ok) setNotifMsg({ ok: true, text: 'Test notification sent' });
      else setNotifMsg({ ok: false, text: data.error ?? JSON.stringify(data.errors) });
    } catch (e: any) {
      setNotifMsg({ ok: false, text: e.message });
    } finally {
      setNotifBusy(false);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const isPro     = licInfo?.tier === 'pro' && licInfo?.valid;
  const atLimit   = licInfo != null && licInfo.device_limit > 0 && licInfo.device_count >= licInfo.device_limit;
  const limitLabel = licInfo?.device_limit === -1 ? 'Unlimited' : String(licInfo?.device_limit ?? 25);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          <button className={`stab${tab === 'license'       ? ' stab--active' : ''}`} onClick={() => setTab('license')}>License</button>
          <button className={`stab${tab === 'notifications' ? ' stab--active' : ''}`} onClick={() => setTab('notifications')}>Notifications</button>
        </div>

        {/* ── License tab ────────────────────────────────────────────── */}
        {tab === 'license' && (
          <div className="settings-section">
            {licInfo ? (
              <>
                <div className={`lic-badge ${isPro ? 'lic-badge--pro' : 'lic-badge--free'}`}>
                  {isPro ? '⚡ WhatsLive Pro' : '🆓 Free Tier'}
                </div>

                <div className="lic-stats">
                  <div className="lic-stat">
                    <span className="lic-stat-label">Devices</span>
                    <span className={`lic-stat-value ${atLimit ? 'lic-stat-value--warn' : ''}`}>
                      {licInfo.device_count} / {limitLabel}
                    </span>
                  </div>
                  {isPro && licInfo.expires_at && (
                    <div className="lic-stat">
                      <span className="lic-stat-label">Expires</span>
                      <span className="lic-stat-value">{new Date(licInfo.expires_at).toLocaleDateString()}</span>
                    </div>
                  )}
                  {isPro && licInfo.tenant_id && (
                    <div className="lic-stat">
                      <span className="lic-stat-label">Account</span>
                      <span className="lic-stat-value">{licInfo.tenant_id}</span>
                    </div>
                  )}
                </div>

                {!isPro && (
                  <p className="lic-cta">
                    Upgrade to <strong>WhatsLive Pro</strong> to monitor unlimited devices, enable webhooks, and access remote relay.
                    <a href="https://whatslive.io/pricing" target="_blank" rel="noreferrer"> View pricing →</a>
                  </p>
                )}
              </>
            ) : (
              <p className="lic-loading">Loading license info…</p>
            )}

            <div className="field-group">
              <label className="field-label">License key</label>
              <textarea
                className="field-input lic-key-input"
                placeholder="Paste your license key here…"
                value={licKey}
                onChange={e => setLicKey(e.target.value)}
                rows={4}
              />
            </div>

            {licMsg && (
              <div className={`settings-msg ${licMsg.ok ? 'settings-msg--ok' : 'settings-msg--err'}`}>
                {licMsg.text}
              </div>
            )}

            <div className="settings-actions">
              <button className="btn btn--primary" onClick={applyLicense} disabled={licBusy || !licKey.trim()}>
                {licBusy ? 'Activating…' : 'Activate Key'}
              </button>
              {isPro && (
                <button className="btn btn--ghost" onClick={clearLicense}>Remove license</button>
              )}
            </div>
          </div>
        )}

        {/* ── Notifications tab ──────────────────────────────────────── */}
        {tab === 'notifications' && (
          <div className="settings-section">
            {!isPro && (
              <div className="notif-pro-gate">
                <span>🔒</span>
                <span>Webhook and Slack notifications require <strong>WhatsLive Pro</strong>.</span>
              </div>
            )}

            <div className="field-group">
              <label className="field-label">Webhook URL</label>
              <p className="field-hint">Receives a POST request on every state change.</p>
              <input
                className="field-input"
                type="url"
                placeholder="https://your-endpoint.com/webhook"
                value={notif.webhook_url}
                onChange={e => setNotif(n => ({ ...n, webhook_url: e.target.value }))}
                disabled={!isPro}
              />
            </div>

            <div className="field-group">
              <label className="field-label">Slack Webhook URL</label>
              <p className="field-hint">Posts a formatted message to a Slack channel.</p>
              <input
                className="field-input"
                type="url"
                placeholder="https://hooks.slack.com/services/…"
                value={notif.slack_webhook_url}
                onChange={e => setNotif(n => ({ ...n, slack_webhook_url: e.target.value }))}
                disabled={!isPro}
              />
            </div>

            {notifMsg && (
              <div className={`settings-msg ${notifMsg.ok ? 'settings-msg--ok' : 'settings-msg--err'}`}>
                {notifMsg.text}
              </div>
            )}

            <div className="settings-actions">
              <button className="btn btn--primary" onClick={saveNotifications} disabled={notifBusy || !isPro}>
                {notifBusy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn--ghost" onClick={testNotification} disabled={notifBusy || !isPro}>
                Send test
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
