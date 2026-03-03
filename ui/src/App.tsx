import { useState, useCallback, useEffect, useMemo } from 'react';
import { SetupPage }        from './components/SetupPage';
import { TopologyMap }      from './components/TopologyMap';
import { DevicePanel }      from './components/DevicePanel';
import { DeviceList }       from './components/DeviceList';
import { GroupsPanel }      from './components/GroupsPanel';
import { WorkspaceTabs }    from './components/WorkspaceTabs';
import { ConnectionBanner } from './components/ConnectionBanner';
import SettingsModal        from './components/SettingsModal';
import { useWebSocket }     from './hooks/useWebSocket';
import { useTheme }         from './hooks/useTheme';
import type { Device, CustomEdge, Group, Workspace, WsEnvelope, StateChangePayload, ConnectionItem, LicenseInfo } from './types';
import { displayName, gatewayMAC as findGatewayMAC, autoEdgeKey } from './types';

// ── Sidebar tab wrapper ────────────────────────────────────────────────────────
interface SidebarTabsProps {
  devices:            Device[];
  groups:             Group[];
  selectedMAC:        string | null;
  showHidden:         boolean;
  onSelectDevice:     (mac: string) => void;
  onToggleShowHidden: () => void;
  onCreateDevice:     (label: string, ip: string, deviceType: string) => Promise<string | null>;
  onCreateGroup:      (name: string, color: string) => void;
  onDeleteGroup:      (id: number) => void;
}

function SidebarTabs({ devices, groups, selectedMAC, showHidden, onSelectDevice, onToggleShowHidden, onCreateDevice, onCreateGroup, onDeleteGroup }: SidebarTabsProps) {
  const [tab, setTab] = useState<'devices' | 'groups'>('devices');
  const downCount = devices.filter(d => d.state === 'down').length;

  return (
    <div className="sidebar-tabs-wrap">
      <nav className="sidebar-tab-bar">
        <button
          className={`stab ${tab === 'devices' ? 'stab--active' : ''}`}
          onClick={() => setTab('devices')}
        >
          Devices
          <span className="stab-count">{devices.filter(d => showHidden || !d.hidden).length}</span>
          {downCount > 0 && <span className="stab-alert">{downCount}</span>}
        </button>
        <button
          className={`stab ${tab === 'groups' ? 'stab--active' : ''}`}
          onClick={() => setTab('groups')}
        >
          Groups
          <span className="stab-count">{groups.length}</span>
        </button>
      </nav>

      <div className="sidebar-tab-content">
        {tab === 'devices' ? (
          <DeviceList
            devices={devices}
            selectedMAC={selectedMAC}
            showHidden={showHidden}
            onSelectDevice={onSelectDevice}
            onToggleShowHidden={onToggleShowHidden}
            onCreateDevice={onCreateDevice}
          />
        ) : (
          <GroupsPanel
            groups={groups}
            devices={devices}
            onCreateGroup={onCreateGroup}
            onDeleteGroup={onDeleteGroup}
          />
        )}
      </div>
    </div>
  );
}

type AppState = 'loading' | 'setup' | 'map';

export default function App() {
  const { theme, toggle: toggleTheme } = useTheme();

  const [appState,      setAppState]      = useState<AppState>('loading');
  const [devices,       setDevices]       = useState<Device[]>([]);
  const [customEdges,   setCustomEdges]   = useState<CustomEdge[]>([]);
  const [groups,        setGroups]        = useState<Group[]>([]);
  const [selectedMAC,   setSelectedMAC]   = useState<string | null>(null);
  const [showHidden,    setShowHidden]    = useState(false);
  const [connectingMAC, setConnectingMAC] = useState<string | null>(null);
  const [showSettings,  setShowSettings]  = useState(false);
  const [licInfo,       setLicInfo]       = useState<LicenseInfo | null>(null);

  // ── Workspaces ─────────────────────────────────────────────────────────────
  const [workspaces,        setWorkspaces]        = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number>(1);
  const [workspacePositions, setWorkspacePositions] = useState<Record<string, {x: number; y: number}>>({});

  // Connection line visibility
  const [showAutoEdges, setShowAutoEdges] = useState<boolean>(() =>
    localStorage.getItem('wl-show-auto') !== 'false');
  const [hiddenAutoEdges, setHiddenAutoEdges] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('wl-hidden-edges') ?? '[]')); }
    catch { return new Set<string>(); }
  });

  // Custom edge colors (keyed by edge DB id)
  const [edgeColors, setEdgeColors] = useState<Record<number, string>>(() => {
    try { return JSON.parse(localStorage.getItem('wl-edge-colors') ?? '{}'); }
    catch { return {}; }
  });

  // Hidden custom edges (hidden but NOT deleted — keyed by edge DB id)
  const [hiddenCustomEdges, setHiddenCustomEdges] = useState<Set<number>>(() => {
    try { return new Set<number>(JSON.parse(localStorage.getItem('wl-hidden-cedges') ?? '[]').map(Number)); }
    catch { return new Set<number>(); }
  });

  // ── License info ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/license')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setLicInfo(d); })
      .catch(() => {});
  }, []);

  // ── Notification permission ────────────────────────────────────────────────
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  function notify(deviceLabel: string, newState: string) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const icon  = newState === 'down'     ? '🔴' : '🟡';
    const title = `${icon} ${deviceLabel} is ${newState.toUpperCase()}`;
    new Notification('WhatsLive', { body: title, icon: '/favicon.ico', tag: deviceLabel });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const handleMessage = useCallback((env: WsEnvelope) => {
    if (env.type === 'snapshot') {
      const list = env.payload as Device[];
      setDevices(list);
      checkSetupStatus(list);
    } else if (env.type === 'state_change') {
      const p = env.payload as StateChangePayload;
      setDevices(prev => prev.map(d => {
        if (d.mac !== p.device_mac) return d;
        const updated = { ...d, state: p.state, latency_ms: p.latency_ms ?? d.latency_ms };
        // Alert when a device goes down or degrades
        if ((p.state === 'down' || p.state === 'degraded') && d.state !== p.state) {
          notify(d.label || d.hostname || d.ip, p.state);
        }
        return updated;
      }));
    } else if (env.type === 'latency_update') {
      const p = env.payload as { device_mac: string; latency_ms: number };
      setDevices(prev => prev.map(d =>
        d.mac === p.device_mac ? { ...d, latency_ms: p.latency_ms } : d
      ));
    } else if (env.type === 'device_added' || env.type === 'device_updated') {
      const device = env.payload as Device;
      setDevices(prev => {
        const idx = prev.findIndex(d => d.mac === device.mac);
        if (idx >= 0) { const n = [...prev]; n[idx] = device; return n; }
        return [...prev, device];
      });
    } else if (env.type === 'device_removed') {
      const { mac } = env.payload as { mac: string };
      setDevices(prev => prev.filter(d => d.mac !== mac));
      setSelectedMAC(prev => prev === mac ? null : prev);
    }
  }, []);

  const { status } = useWebSocket(handleMessage);

  function checkSetupStatus(list: Device[]) {
    fetch('/api/status').then(r => r.json())
      .then(body => setAppState(body.has_subnet || list.length > 0 ? 'map' : 'setup'))
      .catch(() => setAppState(list.length > 0 ? 'map' : 'setup'));
  }

  useEffect(() => {
    fetch('/api/edges').then(r => r.json()).then(setCustomEdges).catch(() => {});
    fetch('/api/groups').then(r => r.json()).then(setGroups).catch(() => {});
    fetch('/api/workspaces').then(r => r.json()).then(setWorkspaces).catch(() => {});
  }, []);

  // ── Device actions ─────────────────────────────────────────────────────────
  async function handleCreateDevice(label: string, ip: string, deviceType: string): Promise<string | null> {
    try {
      const res = await fetch('/api/devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, ip, device_type: deviceType }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return (body as { error?: string }).error ?? `Server error ${res.status}`;
      }
      return null; // success
    } catch (e) {
      return 'Network error — is the backend running?';
    }
  }

  async function handleDeleteDevice(mac: string) {
    await fetch(`/api/devices/${encodeURIComponent(mac)}`, { method: 'DELETE' });
    // WS broadcast handles the state update; ensure selection is cleared immediately
    if (selectedMAC === mac) setSelectedMAC(null);
  }

  async function handleSaveDevice(mac: string, label: string, deviceType: string, ip?: string, notes?: string) {
    const body: Record<string, unknown> = { label, device_type: deviceType };
    if (ip    !== undefined) body.ip    = ip || '0.0.0.0';
    if (notes !== undefined) body.notes = notes;
    await fetch(`/api/devices/${encodeURIComponent(mac)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setDevices(prev => prev.map(d =>
      d.mac === mac
        ? {
            ...d, label, device_type: deviceType,
            ...(ip    !== undefined ? { ip: ip || '0.0.0.0' } : {}),
            ...(notes !== undefined ? { notes }               : {}),
          }
        : d,
    ));
  }

  async function handleToggleHidden(mac: string, hidden: boolean) {
    await fetch(`/api/devices/${encodeURIComponent(mac)}/visibility`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    setDevices(prev => prev.map(d => d.mac === mac ? { ...d, hidden } : d));
    if (hidden && selectedMAC === mac) setSelectedMAC(null);
  }

  async function handleAssignGroup(mac: string, groupId: number | null) {
    await fetch(`/api/devices/${encodeURIComponent(mac)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: groupId }),
    });
    setDevices(prev => prev.map(d => d.mac === mac ? { ...d, group_id: groupId } : d));

    // Auto-hide the device's gateway auto-line when it joins a group; restore when it leaves
    if (gwMAC) {
      const key = autoEdgeKey(mac, gwMAC);
      if (groupId !== null) {
        // Joining a group → hide individual line
        setHiddenAutoEdges(prev => {
          const next = new Set(prev); next.add(key);
          localStorage.setItem('wl-hidden-edges', JSON.stringify([...next])); return next;
        });
      } else {
        // Leaving a group → restore individual line
        setHiddenAutoEdges(prev => {
          const next = new Set(prev); next.delete(key);
          localStorage.setItem('wl-hidden-edges', JSON.stringify([...next])); return next;
        });
      }
    }
  }

  // ── Edge actions ───────────────────────────────────────────────────────────
  async function handleCreateEdge(sourceMac: string, targetMac: string) {
    const res = await fetch('/api/edges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_mac: sourceMac, target_mac: targetMac }),
    });
    if (res.ok) {
      const edge: CustomEdge = await res.json();
      setCustomEdges(prev => [...prev.filter(e => e.id !== edge.id), edge]);
    }
  }

  async function handleDeleteEdge(id: number) {
    await fetch(`/api/edges/${id}`, { method: 'DELETE' });
    setCustomEdges(prev => prev.filter(e => e.id !== id));
    setEdgeColors(prev => { const n = { ...prev }; delete n[id]; localStorage.setItem('wl-edge-colors', JSON.stringify(n)); return n; });
    setHiddenCustomEdges(prev => { const n = new Set(prev); n.delete(id); localStorage.setItem('wl-hidden-cedges', JSON.stringify([...n])); return n; });
  }

  function handleToggleCustomEdge(id: number, currentlyHidden: boolean) {
    setHiddenCustomEdges(prev => {
      const next = new Set(prev);
      if (currentlyHidden) next.delete(id); else next.add(id);
      localStorage.setItem('wl-hidden-cedges', JSON.stringify([...next]));
      return next;
    });
  }

  function handleEdgeColorChange(id: number, color: string) {
    setEdgeColors(prev => {
      const next = { ...prev, [id]: color };
      localStorage.setItem('wl-edge-colors', JSON.stringify(next));
      return next;
    });
  }

  // ── Auto-edge visibility ───────────────────────────────────────────────────
  function handleToggleAutoEdges() {
    setShowAutoEdges(v => { localStorage.setItem('wl-show-auto', String(!v)); return !v; });
  }
  function handleHideAutoEdge(key: string) {
    setHiddenAutoEdges(prev => {
      const next = new Set(prev); next.add(key);
      localStorage.setItem('wl-hidden-edges', JSON.stringify([...next])); return next;
    });
  }
  function handleShowAllEdges() {
    setHiddenAutoEdges(new Set()); localStorage.removeItem('wl-hidden-edges');
    setShowAutoEdges(true); localStorage.setItem('wl-show-auto', 'true');
  }
  function handleToggleEdge(key: string, currentlyHidden: boolean) {
    if (currentlyHidden) {
      setHiddenAutoEdges(prev => {
        const next = new Set(prev); next.delete(key);
        localStorage.setItem('wl-hidden-edges', JSON.stringify([...next])); return next;
      });
    } else { handleHideAutoEdge(key); }
  }

  // ── Group actions ──────────────────────────────────────────────────────────
  async function handleCreateGroup(name: string, color: string): Promise<Group | null> {
    const res = await fetch('/api/groups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (res.ok) {
      const group: Group = await res.json();
      setGroups(prev => [...prev, group]);
      return group;
    }
    return null;
  }

  async function handleDeleteGroup(id: number) {
    await fetch(`/api/groups/${id}`, { method: 'DELETE' });
    setGroups(prev => prev.filter(g => g.id !== id));
    setDevices(prev => prev.map(d => d.group_id === id ? { ...d, group_id: null } : d));
  }

  async function handleGroupMoved(id: number, x: number, y: number) {
    await fetch(`/api/groups/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    });
    setGroups(prev => prev.map(g => g.id === id ? { ...g, x, y } : g));
  }

  // ── Workspace actions ──────────────────────────────────────────────────────
  async function handleSwitchWorkspace(id: number) {
    setActiveWorkspaceId(id);
    setSelectedMAC(null);
    if (id === 1) {
      setWorkspacePositions({});
      return;
    }
    try {
      const data = await fetch(`/api/workspaces/${id}/positions`).then(r => r.json());
      setWorkspacePositions(data as Record<string, {x: number; y: number}>);
    } catch {
      setWorkspacePositions({});
    }
  }

  async function handleCreateWorkspace(name: string, groupId: number | null): Promise<Workspace | null> {
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, group_id: groupId }),
      });
      if (!res.ok) return null;
      const ws: Workspace = await res.json();
      setWorkspaces(prev => [...prev, ws]);
      handleSwitchWorkspace(ws.id);
      return ws;
    } catch { return null; }
  }

  async function handleRenameWorkspace(id: number, name: string) {
    await fetch(`/api/workspaces/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, name } : w));
  }

  async function handleDeleteWorkspace(id: number) {
    await fetch(`/api/workspaces/${id}`, { method: 'DELETE' });
    setWorkspaces(prev => prev.filter(w => w.id !== id));
    if (activeWorkspaceId === id) handleSwitchWorkspace(1);
  }

  // Called from TopologyMap when user taps a group node — open/create its workspace
  async function handleOpenGroupWorkspace(groupId: number) {
    const existing = workspaces.find(w => w.group_id === groupId);
    if (existing) { handleSwitchWorkspace(existing.id); return; }
    const grp = groups.find(g => g.id === groupId);
    await handleCreateWorkspace(grp?.name ?? `Group ${groupId}`, groupId);
  }

  // ── Derived: connections for selected device ───────────────────────────────
  const gwMAC = useMemo(() => findGatewayMAC(devices), [devices]);

  const selectedConnections = useMemo((): ConnectionItem[] => {
    if (!selectedMAC) return [];
    const result: ConnectionItem[] = [];

    if (gwMAC) {
      if (selectedMAC === gwMAC) {
        devices.filter(d => d.mac !== gwMAC && !d.hidden).forEach(d => {
          const key = autoEdgeKey(gwMAC, d.mac);
          result.push({ kind: 'auto', edgeKey: key, otherMAC: d.mac, otherName: displayName(d), hidden: hiddenAutoEdges.has(key) });
        });
      } else {
        const key = autoEdgeKey(selectedMAC, gwMAC);
        const gw  = devices.find(d => d.mac === gwMAC);
        if (gw) result.push({ kind: 'auto', edgeKey: key, otherMAC: gwMAC, otherName: displayName(gw), hidden: hiddenAutoEdges.has(key) });
      }
    }

    customEdges.filter(e => e.source_mac === selectedMAC || e.target_mac === selectedMAC).forEach(e => {
      const otherRef  = e.source_mac === selectedMAC ? e.target_mac : e.source_mac;
      let   otherName: string;
      if (otherRef.startsWith('grp:')) {
        const gid  = parseInt(otherRef.slice(4), 10);
        const grp  = groups.find(g => g.id === gid);
        otherName  = grp ? `▭ ${grp.name}` : `Group ${gid}`;
      } else {
        const other = devices.find(d => d.mac === otherRef);
        otherName   = other ? displayName(other) : otherRef;
      }
      result.push({ kind: 'custom', edgeId: e.id, otherMAC: otherRef, otherName, hidden: hiddenCustomEdges.has(e.id), edgeLabel: e.label || undefined });
    });

    return result;
  }, [selectedMAC, devices, customEdges, groups, gwMAC, hiddenAutoEdges, hiddenCustomEdges]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const selectedDevice   = devices.find(d => d.mac === selectedMAC) ?? null;
  const activeWorkspace  = workspaces.find(w => w.id === activeWorkspaceId) ?? null;
  const downCount        = devices.filter(d => d.state === 'down').length;
  const degradedCount    = devices.filter(d => d.state === 'degraded').length;
  const upCount          = devices.filter(d => d.state === 'up').length;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (appState === 'loading') {
    return <div className="loading-screen"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></div>;
  }
  if (appState === 'setup') return <SetupPage onComplete={() => setAppState('map')} />;

  return (
    <div className="app">
      <ConnectionBanner status={status} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <header className="app-header">
        <div className="header-brand">
          <svg className="header-logo-svg" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="4.5" fill="currentColor" />
            <circle cx="14" cy="14" r="8.5"  stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
            <circle cx="14" cy="14" r="13"   stroke="currentColor" strokeWidth="1"   opacity="0.3" />
          </svg>
          <span className="header-name">WhatsLive</span>
        </div>
        <div className="header-right">
          <div className="header-stats">
            {downCount > 0     && <span className="stat-badge stat-badge--down">{downCount} down</span>}
            {degradedCount > 0 && <span className="stat-badge stat-badge--degraded">{degradedCount} degraded</span>}
            <span className="stat-badge stat-badge--up">{upCount} up</span>
            <span className="stat-total">{devices.length} devices</span>
            {licInfo && licInfo.tier === 'free' && licInfo.device_limit > 0 && (
              <button
                className={`lic-cap-badge${devices.length >= licInfo.device_limit ? ' lic-cap-badge--warn' : ''}`}
                onClick={() => setShowSettings(true)}
                title="Device limit — click to manage license"
              >
                {devices.length}/{licInfo.device_limit} devices
              </button>
            )}
          </div>
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? '☀' : '☽'}
          </button>
          <button className="settings-btn" onClick={() => setShowSettings(true)} title="Settings">
            ⚙
          </button>
        </div>
      </header>

      <div className="app-main">
        <div className="map-area">
          <WorkspaceTabs
            workspaces={workspaces}
            activeId={activeWorkspaceId}
            groups={groups}
            onSwitch={handleSwitchWorkspace}
            onCreate={handleCreateWorkspace}
            onRename={handleRenameWorkspace}
            onDelete={handleDeleteWorkspace}
            onGoToOverview={() => handleSwitchWorkspace(1)}
          />
          <TopologyMap
            devices={devices}
            customEdges={customEdges}
            groups={groups}
            selectedMAC={selectedMAC}
            showHidden={showHidden}
            connectingMAC={connectingMAC}
            showAutoEdges={showAutoEdges}
            hiddenAutoEdges={hiddenAutoEdges}
            hiddenCustomEdges={hiddenCustomEdges}
            edgeColors={edgeColors}
            theme={theme}
            workspaceId={activeWorkspaceId}
            workspaceGroupId={activeWorkspace?.group_id ?? null}
            workspacePositions={workspacePositions}
            onSelectDevice={setSelectedMAC}
            onToggleHidden={handleToggleHidden}
            onCreateEdge={handleCreateEdge}
            onDeleteEdge={handleDeleteEdge}
            onConnectEnd={() => setConnectingMAC(null)}
            onHideAutoEdge={handleHideAutoEdge}
            onToggleAutoEdges={handleToggleAutoEdges}
            onShowAllEdges={handleShowAllEdges}
            onEdgeColorChange={handleEdgeColorChange}
            onGroupMoved={handleGroupMoved}
            onOpenGroupWorkspace={handleOpenGroupWorkspace}
            onGoToOverview={() => handleSwitchWorkspace(1)}
          />
        </div>

        <aside className="sidebar">
          {selectedDevice ? (
            <DevicePanel
              device={selectedDevice}
              groups={groups}
              connections={selectedConnections}
              showAutoEdges={showAutoEdges}
              onBack={() => setSelectedMAC(null)}
              onSave={handleSaveDevice}
              onToggleHidden={handleToggleHidden}
              onDeleteDevice={handleDeleteDevice}
              onConnect={mac => { setConnectingMAC(mac); setSelectedMAC(null); }}
              onAssignGroup={handleAssignGroup}
              onCreateGroup={handleCreateGroup}
              onToggleAutoEdge={handleToggleEdge}
              onToggleCustomEdge={handleToggleCustomEdge}
              onDeleteEdge={handleDeleteEdge}
              onShowAllEdges={handleShowAllEdges}
            />
          ) : (
            <SidebarTabs
              devices={devices}
              groups={groups}
              selectedMAC={selectedMAC}
              showHidden={showHidden}
              onSelectDevice={setSelectedMAC}
              onToggleShowHidden={() => setShowHidden(v => !v)}
              onCreateDevice={handleCreateDevice}
              onCreateGroup={handleCreateGroup}
              onDeleteGroup={handleDeleteGroup}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
