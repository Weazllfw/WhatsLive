export type DeviceState = 'unknown' | 'up' | 'degraded' | 'down' | 'ignored';

export const DEVICE_TYPES = [
  'router', 'firewall', 'switch', 'ap',
  'server', 'nas', 'printer',
  'workstation', 'laptop', 'phone', 'tv', 'camera',
  'isp', 'cloud',
  'generic',
] as const;

export const COLOR_PRESETS = [
  '#7c3aed', // purple  (default for custom edges)
  '#0ea5e9', // sky
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#94a3b8', // slate
  '#ec4899', // pink
  '#14b8a6', // teal
] as const;

export const GROUP_COLORS = [
  '#1e3a5c', '#1e3a2e', '#3a1e1e',
  '#2e1e3a', '#1e2e3a', '#3a2e1e',
] as const;
export type DeviceType = typeof DEVICE_TYPES[number];

export interface Device {
  mac:         string;
  ip:          string;
  hostname:    string;
  label:       string;
  vendor:      string;
  device_type: string;
  state:       DeviceState;
  hidden:      boolean;
  group_id:    number | null;
  is_custom:   boolean;
  notes:       string;
  latency_ms?: number;      // last ICMP round-trip (ms); undefined = not yet measured
  first_seen:  string;
  last_seen:   string;
  pos_x?:      number;
  pos_y?:      number;
}

export interface CustomEdge {
  id:         number;
  source_mac: string;
  target_mac: string;
  label:      string;
}

export interface Group {
  id:    number;
  name:  string;
  color: string;
  x?:    number;
  y?:    number;
}

export interface Workspace {
  id:         number;
  name:       string;
  group_id:   number | null;
  sort_order: number;
}

export interface WsEnvelope {
  type:    'snapshot' | 'state_change' | 'device_added' | 'device_updated' | 'device_removed' | 'latency_update';
  v:       number;
  payload: unknown;
}

export interface StateChangePayload {
  device_mac: string;
  state:      DeviceState;
  at:         string;
  latency_ms: number; // 0 = unavailable
}

export interface LicenseInfo {
  tier:         'free' | 'pro';
  tenant_id?:   string;
  device_limit: number;   // -1 = unlimited
  expires_at?:  string;
  valid:        boolean;
  device_count: number;
}

export interface NotificationSettings {
  webhook_url:       string;
  slack_webhook_url: string;
}

export const STATE_COLOURS: Record<DeviceState, string> = {
  up:       '#22c55e',
  degraded: '#f59e0b',
  down:     '#ef4444',
  unknown:  '#94a3b8',
  ignored:  '#475569',
};

/** A single entry in a device's connection list shown in the sidebar panel. */
export interface ConnectionItem {
  kind:       'auto' | 'custom';
  otherMAC:   string;
  otherName:  string;
  hidden?:    boolean;
  edgeKey?:   string;    // auto-edges: sorted-mac key
  edgeId?:    number;    // custom edges: DB id
  edgeLabel?: string;    // custom edges: user label
}

/** Derive the gateway MAC from the device list (first router, then .1, then .254). */
export function gatewayMAC(devices: Device[]): string | null {
  const vis = devices.filter(d => !d.hidden);
  return (
    vis.find(d => d.device_type === 'router')?.mac ??
    vis.find(d => /\.1$/.test(d.ip))?.mac ??
    vis.find(d => /\.254$/.test(d.ip))?.mac ??
    null
  );
}

/** Canonical key for an auto-edge (mac pair, alphabetically sorted). */
export function autoEdgeKey(mac1: string, mac2: string): string {
  return [mac1, mac2].sort().join(':');
}

// Canonical display name for a device — label > short hostname > IP
export function displayName(d: Device): string {
  if (d.label) return d.label;
  if (!d.hostname) return d.ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d.hostname)) return d.ip;
  return d.hostname.split('.')[0];
}
