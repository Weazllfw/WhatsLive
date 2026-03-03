import { useEffect, useRef, useCallback, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Router, Network, Server, Wifi, HardDrive, Printer, Monitor, LayoutGrid,
  Shield, Globe, Cloud, Phone, Tv, Camera, Laptop, MonitorSpeaker,
} from 'lucide-react';
import cytoscape from 'cytoscape';
import type { Core, NodeSingular, EdgeSingular } from 'cytoscape';
import type { Device, CustomEdge, Group } from '../types';
import { STATE_COLOURS, COLOR_PRESETS, displayName, autoEdgeKey, gatewayMAC as findGatewayMAC } from '../types';
import type { Theme } from '../hooks/useTheme';

// ── Icon factory using Lucide React ──────────────────────────────────────────
// Renders each Lucide component to an SVG data-URI for use as a Cytoscape
// background-image.  Lucide icons use a 24×24 viewBox with content
// centred at (12,12) — exactly what Cytoscape's 50%/50% background-position needs.

const LUCIDE_PROPS = { size: 24, strokeWidth: 1.75, absoluteStrokeWidth: true };

type LucideComponent = React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number; absoluteStrokeWidth?: boolean; color?: string }>;

function lucideIcon(Component: LucideComponent, color: string): string {
  const markup = renderToStaticMarkup(
    <Component {...LUCIDE_PROPS} color={color} />,
  );
  return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

function buildIcons(color: string): Record<string, string> {
  return {
    router:      lucideIcon(Router,        color),
    firewall:    lucideIcon(Shield,        color),
    switch:      lucideIcon(Network,       color),
    ap:          lucideIcon(Wifi,          color),
    server:      lucideIcon(Server,        color),
    nas:         lucideIcon(HardDrive,     color),
    printer:     lucideIcon(Printer,       color),
    workstation: lucideIcon(Monitor,       color),
    laptop:      lucideIcon(Laptop,        color),
    phone:       lucideIcon(Phone,         color),
    tv:          lucideIcon(Tv,            color),
    camera:      lucideIcon(Camera,        color),
    isp:         lucideIcon(Globe,         color),
    cloud:       lucideIcon(Cloud,         color),
    generic:     lucideIcon(MonitorSpeaker, color),
    group:       lucideIcon(LayoutGrid,    color),
  };
}

const ICONS: Record<Theme, Record<string, string>> = {
  dark:  buildIcons('rgba(255,255,255,0.90)'),
  light: buildIcons('rgba(15,23,42,0.85)'),
};

const TOKENS = {
  dark:  {
    nodeBg: '#07101e', gatewayBg: '#05091a',
    textColor: '#c4d8f0', textBgColor: '#06091a', textBgOpacity: 0.88,
    edgeColor: '#1a3050',
    nodeShadowOpacity: 0.38, gatewayShadowOpacity: 0.55,
    groupBgOpacity: 0.08, groupBorderOpacity: 0.90,
  },
  light: {
    nodeBg: '#1b3055', gatewayBg: '#0f2040',
    textColor: '#f0f8ff', textBgColor: '#1b3055', textBgOpacity: 0.92,
    edgeColor: '#7090b0',
    nodeShadowOpacity: 0.0, gatewayShadowOpacity: 0.0,
    groupBgOpacity: 0.14, groupBorderOpacity: 1.0,
  },
};

// ── Group state helper ────────────────────────────────────────────────────────

function updateGroupStates(cy: Core) {
  cy.nodes('.group-node').forEach(group => {
    const children = group.children().not('.group-node');
    const colors   = children.map(n => n.data('stateColor') as string).filter(Boolean);
    const stateColor =
      colors.includes(STATE_COLOURS.down)     ? STATE_COLOURS.down :
      colors.includes(STATE_COLOURS.degraded) ? STATE_COLOURS.degraded :
      colors.some(c => c === STATE_COLOURS.up) ? STATE_COLOURS.up :
                                                  STATE_COLOURS.unknown;
    const total    = children.length;
    const downCt   = children.filter(n => n.data('stateColor') === STATE_COLOURS.down).length;
    const degradCt = children.filter(n => n.data('stateColor') === STATE_COLOURS.degraded).length;
    const suffix   = [
      downCt   > 0 ? `${downCt} ↓` : '',
      degradCt > 0 ? `${degradCt} !` : '',
    ].filter(Boolean).join(' ');
    group.data({
      groupStateColor: stateColor,
      groupLabel: group.data('name') + (total > 0 ? `\n${total} device${total !== 1 ? 's' : ''}${suffix ? '  ' + suffix : ''}` : ''),
    });
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

type EdgeAction = { label: string; x: number; y: number } &
  ( { kind: 'auto';   edgeKey: string }
  | { kind: 'custom'; id: number; currentColor: string; currentLabel: string });

// ── Scale overlay ─────────────────────────────────────────────────────────────

interface SelBB {
  left: number; top: number; right: number; bottom: number; // screen px
  mx1:  number; my1: number; mx2:   number; my2:   number; // model space
}

// Each handle: px/py = fraction along BB (0=min, 0.5=mid, 1=max)
// ax/ay = fraction of the anchor (opposite corner/edge that stays fixed)
const SCALE_HANDLES = [
  { id:'nw', cursor:'nw-resize', px:0,   py:0,   ax:1,   ay:1,   sx:true,  sy:true  },
  { id:'n',  cursor:'n-resize',  px:0.5, py:0,   ax:0.5, ay:1,   sx:false, sy:true  },
  { id:'ne', cursor:'ne-resize', px:1,   py:0,   ax:0,   ay:1,   sx:true,  sy:true  },
  { id:'e',  cursor:'e-resize',  px:1,   py:0.5, ax:0,   ay:0.5, sx:true,  sy:false },
  { id:'se', cursor:'se-resize', px:1,   py:1,   ax:0,   ay:0,   sx:true,  sy:true  },
  { id:'s',  cursor:'s-resize',  px:0.5, py:1,   ax:0.5, ay:0,   sx:false, sy:true  },
  { id:'sw', cursor:'sw-resize', px:0,   py:1,   ax:1,   ay:0,   sx:true,  sy:true  },
  { id:'w',  cursor:'w-resize',  px:0,   py:0.5, ax:1,   ay:0.5, sx:true,  sy:false },
] as const;

type HandleDef = typeof SCALE_HANDLES[number];

interface Props {
  devices:          Device[];
  customEdges:      CustomEdge[];
  groups:           Group[];
  selectedMAC:      string | null;
  showHidden:       boolean;
  connectingMAC:    string | null;
  showAutoEdges:    boolean;
  hiddenAutoEdges:   ReadonlySet<string>;
  hiddenCustomEdges: ReadonlySet<number>;
  edgeColors:        Record<number, string>;
  theme:            Theme;
  // Workspace
  workspaceId:          number;
  workspaceGroupId:     number | null;
  workspacePositions:   Record<string, {x: number; y: number}>;
  onSelectDevice:   (mac: string | null) => void;
  onToggleHidden:   (mac: string, h: boolean) => void;
  onCreateEdge:     (src: string, tgt: string) => void;
  onDeleteEdge:     (id: number) => void;
  onConnectEnd:     () => void;
  onHideAutoEdge:   (key: string) => void;
  onToggleAutoEdges:() => void;
  onShowAllEdges:   () => void;
  onEdgeColorChange:(id: number, color: string) => void;
  onGroupMoved:     (id: number, x: number, y: number) => void;
  onOpenGroupWorkspace: (groupId: number) => void;
  onGoToOverview:   () => void;
}

export function TopologyMap({
  devices, customEdges, groups, selectedMAC, showHidden,
  connectingMAC, showAutoEdges, hiddenAutoEdges, hiddenCustomEdges, edgeColors, theme,
  workspaceId, workspaceGroupId, workspacePositions,
  onSelectDevice, onToggleHidden, onCreateEdge, onDeleteEdge, onConnectEnd,
  onHideAutoEdge, onToggleAutoEdges, onShowAllEdges, onEdgeColorChange, onGroupMoved,
  onOpenGroupWorkspace, onGoToOverview,
}: Props) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const cyRef           = useRef<Core | null>(null);
  const gatewayRef      = useRef<string | null>(null);
  const devicesRef      = useRef<Device[]>([]);
  const workspaceIdRef  = useRef<number>(workspaceId);
  useEffect(() => { workspaceIdRef.current = workspaceId; }, [workspaceId]);

  // Tracks the Overview (ws id=1) positions so they can be restored when
  // switching back from a non-Overview workspace.  Initialised from pos_x/pos_y
  // in syncDevices; updated on every drag while workspaceId === 1.
  const overviewPositionsRef = useRef<Record<string, { x: number; y: number }>>({});

  // Stable callback refs
  const cbSelect            = useRef(onSelectDevice);
  const cbConnectEnd        = useRef(onConnectEnd);
  const cbCreateEdge        = useRef(onCreateEdge);
  const cbGroupMoved        = useRef(onGroupMoved);
  const cbEdgeColor         = useRef(onEdgeColorChange);
  const cbOpenGroupWorkspace = useRef(onOpenGroupWorkspace);
  const cbGoToOverview       = useRef(onGoToOverview);
  useEffect(() => { cbSelect.current             = onSelectDevice;        }, [onSelectDevice]);
  useEffect(() => { cbConnectEnd.current         = onConnectEnd;          }, [onConnectEnd]);
  useEffect(() => { cbCreateEdge.current         = onCreateEdge;          }, [onCreateEdge]);
  useEffect(() => { cbGroupMoved.current         = onGroupMoved;          }, [onGroupMoved]);
  useEffect(() => { cbEdgeColor.current          = onEdgeColorChange;     }, [onEdgeColorChange]);
  useEffect(() => { cbOpenGroupWorkspace.current = onOpenGroupWorkspace;  }, [onOpenGroupWorkspace]);
  useEffect(() => { cbGoToOverview.current       = onGoToOverview;        }, [onGoToOverview]);

  const [edgeAction, setEdgeAction] = useState<EdgeAction | null>(null);
  const [selBB,      setSelBB]      = useState<SelBB | null>(null);
  // Stable ref to the bounding-box computer, set inside the init effect where cy is captured.
  const computeSelBBRef = useRef<(() => SelBB | null) | null>(null);

  // ── Init Cytoscape ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const t = TOKENS.dark;

    const cy = cytoscape({
      container: containerRef.current,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style: ([
        {
          selector: 'node',
          style: {
            'width': 56, 'height': 56, 'shape': 'ellipse',
            'background-color': t.nodeBg,
            'border-width': 3.5, 'border-color': 'data(stateColor)',
            'background-image': 'data(icon)',
            'background-fit': 'none',
            'background-width': '58%', 'background-height': '58%',
            'background-position-x': '50%', 'background-position-y': '50%',
            'label': 'data(label)',
            'color': t.textColor, 'font-size': '11px',
            'font-family': '"Inter", "Segoe UI", system-ui, sans-serif', 'font-weight': 600,
            'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': 9,
            'text-wrap': 'wrap', 'text-max-width': '200px',
            'text-background-opacity': 0,
            'text-outline-color': t.textBgColor, 'text-outline-width': 3, 'text-outline-opacity': t.textBgOpacity,
            // State-colour glow (dark mode defining visual; suppressed in light mode)
            'shadow-blur': 14, 'shadow-color': 'data(stateColor)',
            'shadow-opacity': t.nodeShadowOpacity, 'shadow-offset-x': 0, 'shadow-offset-y': 0,
            // Smooth animation when status (border / glow) changes
            'transition-property': 'border-color shadow-color shadow-opacity opacity',
            'transition-duration': 400,
            'transition-timing-function': 'ease-in-out-sine',
          },
        },
        {
          selector: 'node[?isGateway]',
          style: {
            'width': 74, 'height': 74, 'background-color': t.gatewayBg,
            'border-width': 4.5, 'font-weight': 700, 'font-size': '12px',
            'shadow-blur': 22, 'shadow-opacity': t.gatewayShadowOpacity,
          },
        },
        { selector: 'node.hidden-node',        style: { 'opacity': 0.22, 'shadow-opacity': 0 } },
        { selector: 'node.connecting-source',  style: { 'border-color': '#f59e0b', 'border-width': 5, 'shadow-color': '#f59e0b', 'shadow-blur': 22, 'shadow-opacity': 0.7 } },
        { selector: 'node.connect-hover',      style: { 'border-color': '#4f87f0', 'border-width': 4.5, 'shadow-color': '#4f87f0', 'shadow-blur': 18, 'shadow-opacity': 0.6 } },
        { selector: 'node:selected',           style: { 'border-color': '#4f87f0', 'border-width': 4.5, 'shadow-color': '#4f87f0', 'shadow-blur': 26, 'shadow-opacity': 0.75 } },
        { selector: 'node:active',             style: { 'overlay-opacity': 0 } },
        // Group compound container
        {
          selector: 'node.group-node',
          style: {
            'shape': 'roundrectangle',
            'background-color': 'data(groupColor)', 'background-opacity': t.groupBgOpacity,
            'border-width': 2, 'border-style': 'solid',
            'border-color': 'data(groupStateColor)', 'border-opacity': t.groupBorderOpacity,
            'label': 'data(groupLabel)', 'color': 'data(groupColor)',
            'font-size': '11px', 'font-weight': 700,
            'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -8,
            'text-wrap': 'wrap', 'text-max-width': '220px',
            'text-background-opacity': 0,
            'text-outline-color': t.textBgColor, 'text-outline-width': 3, 'text-outline-opacity': 0.8,
            'width': 'label', 'height': 'label', 'padding': '34px',
            'background-image': 'none',
            'shadow-blur': 12, 'shadow-color': 'data(groupStateColor)', 'shadow-opacity': 0.25, 'shadow-offset-x': 0, 'shadow-offset-y': 0,
            'transition-property': 'border-color shadow-color shadow-opacity',
            'transition-duration': 400,
            'transition-timing-function': 'ease-in-out-sine',
          },
        },
        { selector: 'node.group-node.connect-hover',     style: { 'border-color': '#4f87f0', 'border-width': 2.5, 'background-opacity': 0.15, 'shadow-color': '#4f87f0', 'shadow-blur': 16, 'shadow-opacity': 0.5 } },
        { selector: 'node.group-node.connecting-source', style: { 'border-color': '#f59e0b', 'border-width': 2.5, 'shadow-color': '#f59e0b', 'shadow-blur': 16, 'shadow-opacity': 0.5 } },
        { selector: 'edge.auto-edge',          style: { 'width': 1.5, 'line-color': t.edgeColor, 'opacity': 0.50, 'curve-style': 'bezier' } },
        { selector: 'edge.auto-edge:selected', style: { 'line-color': '#3d5880', 'width': 2.5, 'opacity': 1 } },
        {
          selector: 'edge.custom-edge',
          style: {
            'width': 2.5, 'line-color': 'data(edgeColor)', 'line-style': 'dashed',
            'line-dash-pattern': [10, 4], 'opacity': 0.85, 'curve-style': 'bezier',
            'label': 'data(edgeLabel)',
            'font-size': '9px', 'font-weight': 600,
            'color': 'data(edgeColor)',
            'text-rotation': 'autorotate',
            'text-background-color': t.textBgColor,
            'text-background-opacity': 0.85,
            'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle',
          },
        },
        { selector: 'edge.custom-edge:selected', style: { 'width': 4, 'opacity': 1 } },
        { selector: 'edge:active', style: { 'overlay-opacity': 0 } },
      ]) as any,
      layout: { name: 'preset' },
      wheelSensitivity: 0.3,
      minZoom: 0.1, maxZoom: 6,
    });

    cy.on('tap', (evt) => {
      if (evt.target !== cy) return;
      cbSelect.current(null);
      setEdgeAction(null);
      // Tapping the empty canvas while in a sub-workspace → return to Overview.
      if (workspaceIdRef.current !== 1) {
        cbGoToOverview.current();
      }
    });

    cy.on('tap', 'node', (evt) => {
      const node = evt.target as NodeSingular;
      if (node.hasClass('group-node')) {
        const gid = parseInt(node.data('groupDbId'), 10);
        if (!isNaN(gid)) cbOpenGroupWorkspace.current(gid);
        return;
      }
      setEdgeAction(null);
      cbSelect.current(node.id());
    });

    // Auto-edge click
    cy.on('tap', 'edge.auto-edge', (evt) => {
      const edge = evt.target as EdgeSingular;
      const rp   = evt.renderedPosition;
      const key  = edge.data('edgeKey') as string;
      const src  = devicesRef.current.find(d => d.mac === edge.source().id());
      const tgt  = devicesRef.current.find(d => d.mac === edge.target().id());
      setEdgeAction({ kind: 'auto', edgeKey: key, label: `${src ? displayName(src) : '?'} ↔ ${tgt ? displayName(tgt) : '?'}`, x: rp.x, y: rp.y });
    });

    // Custom edge click
    cy.on('tap', 'edge.custom-edge', (evt) => {
      const edge  = evt.target as EdgeSingular;
      const rp    = evt.renderedPosition;
      const eid   = parseInt(edge.data('dbId'), 10);
      const color = edge.data('edgeColor') as string;
      const srcNode = edge.source();
      const tgtNode = edge.target();
      const nodeLabel = (n: NodeSingular) => {
        if (n.hasClass('group-node')) return n.data('name') as string;
        const dev = devicesRef.current.find(d => d.mac === n.id());
        return dev ? displayName(dev) : n.id();
      };
      const srcLabel = nodeLabel(srcNode);
      const tgtLabel = nodeLabel(tgtNode);
      const currentLabel = (edge.data('edgeLabel') as string) || '';
      setEdgeAction({ kind: 'custom', id: eid, currentColor: color, currentLabel, label: `${srcLabel} → ${tgtLabel}`, x: rp.x, y: rp.y });
    });

    cy.on('dragfree', 'node', (evt) => {
      const node    = evt.target as NodeSingular;
      const pos     = node.position();
      const wsId    = workspaceIdRef.current;

      function saveDevicePos(mac: string, x: number, y: number) {
        const url = wsId === 1
          ? `/api/devices/${encodeURIComponent(mac)}/position`
          : `/api/workspaces/${wsId}/devices/${encodeURIComponent(mac)}/position`;
        fetch(url, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y }),
        }).catch(() => {});
        // Keep Overview cache current so switching back restores the right position.
        if (wsId === 1) overviewPositionsRef.current[mac] = { x, y };
      }

      if (node.hasClass('group-node')) {
        // When a group compound node is dragged, save all children's new positions.
        node.children().not('.group-node').forEach(child => {
          const cp = child.position();
          saveDevicePos(child.id(), cp.x, cp.y);
        });
        const gid = parseInt(node.data('groupDbId'), 10);
        if (!isNaN(gid)) cbGroupMoved.current(gid, pos.x, pos.y);
      } else {
        saveDevicePos(node.id(), pos.x, pos.y);
      }
    });

    // ── Selection bounding-box for scale overlay ────────────────────────────
    const computeSelBB = (): SelBB | null => {
      const sel = cy.$(':selected').filter('node');
      // Require genuine multi-select (≥2 nodes). Single-node or single-group
      // clicks are not intercepted — groups keep their click-to-open-workspace behaviour.
      if (sel.length < 2) return null;
      const bb = sel.boundingBox({});
      if (!bb || bb.w < 2 || bb.h < 2) return null;
      const z = cy.zoom(), p = cy.pan();
      return {
        left: bb.x1 * z + p.x, top:  bb.y1 * z + p.y,
        right: bb.x2 * z + p.x, bottom: bb.y2 * z + p.y,
        mx1: bb.x1, my1: bb.y1, mx2: bb.x2, my2: bb.y2,
      };
    };
    computeSelBBRef.current = computeSelBB;
    let bbRaf = 0;
    const schedBB = () => {
      cancelAnimationFrame(bbRaf);
      bbRaf = requestAnimationFrame(() => setSelBB(computeSelBBRef.current?.() ?? null));
    };
    cy.on('select unselect', schedBB);
    cy.on('position', 'node', schedBB);
    cy.on('viewport', schedBB);

    cyRef.current = cy;
    // Re-measure after flex layout settles (layout paint runs before useEffect)
    requestAnimationFrame(() => { cy.resize(); });
    return () => { cancelAnimationFrame(bbRaf); cy.destroy(); cyRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect mode ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (!connectingMAC) { cy.nodes().removeClass('connecting-source connect-hover'); return; }
    cy.getElementById(connectingMAC).addClass('connecting-source');

    function onClick(evt: cytoscape.EventObject) {
      const node = evt.target as NodeSingular;
      const cyId = node.id();
      if (cyId === connectingMAC) { cbConnectEnd.current(); return; }
      // Groups have Cytoscape IDs like "group-3" but are stored as "grp:3" in the DB
      const targetRef = node.hasClass('group-node')
        ? `grp:${node.data('groupDbId') as string}`
        : cyId;
      cbCreateEdge.current(connectingMAC!, targetRef);
      cbConnectEnd.current();
    }
    function onOver(evt: cytoscape.EventObject) { const n = evt.target as NodeSingular; if (n.id() !== connectingMAC) n.addClass('connect-hover'); }
    function onOut(evt: cytoscape.EventObject)  { (evt.target as NodeSingular).removeClass('connect-hover'); }

    cy.on('tap', 'node', onClick);
    cy.on('mouseover', 'node', onOver);
    cy.on('mouseout',  'node', onOut);
    return () => {
      cy.off('tap', 'node', onClick);
      cy.off('mouseover', 'node', onOver);
      cy.off('mouseout',  'node', onOut);
      cy.nodes().removeClass('connecting-source connect-hover');
    };
  }, [connectingMAC]);

  useEffect(() => {
    function h(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (connectingMAC) cbConnectEnd.current();
      setEdgeAction(null);
    }
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [connectingMAC]);

  // ── Theme ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const t = TOKENS[theme];
    cy.style()
      .selector('node').style({ 'background-color': t.nodeBg, 'color': t.textColor, 'text-background-color': t.textBgColor, 'text-background-opacity': t.textBgOpacity })
      .selector('node[?isGateway]').style({ 'background-color': t.gatewayBg })
      .selector('edge.auto-edge').style({ 'line-color': t.edgeColor })
      .update();
    cy.nodes().not('.group-node').forEach(n => {
      const dev = devicesRef.current.find(d => d.mac === n.id());
      if (dev) n.data('icon', ICONS[theme][dev.device_type] ?? ICONS[theme].generic);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // ── Sync groups ──────────────────────────────────────────────────────────────
  const syncGroups = useCallback((grps: Group[], wsGroupId: number | null) => {
    const cy = cyRef.current;
    if (!cy) return;
    // In a group-filtered workspace, only show the linked group node
    const filtered  = wsGroupId !== null ? grps.filter(g => g.id === wsGroupId) : grps;
    const incoming  = new Set(filtered.map(g => `group-${g.id}`));
    cy.nodes('.group-node').forEach(n => { if (!incoming.has(n.id())) cy.remove(n); });

    filtered.forEach(g => {
      const gid = `group-${g.id}`;
      const ex  = cy.getElementById(gid);
      if (ex.length) {
        ex.data({ name: g.name, groupColor: g.color });
        // Do NOT reposition existing groups — their visual position is determined
        // by their children's absolute coordinates.  Calling ex.position() here
        // would move all children back to a stale centroid on every state update.
      } else {
        cy.add({
          group: 'nodes',
          data: { id: gid, name: g.name, groupLabel: g.name, groupColor: g.color, groupStateColor: STATE_COLOURS.unknown, groupDbId: String(g.id) },
          classes: 'group-node',
          position: { x: g.x ?? 400, y: g.y ?? 300 },
        });
      }
    });

    devicesRef.current.forEach(d => {
      const node     = cy.getElementById(d.mac);
      if (!node.length) return;
      const parentId = d.group_id != null && cy.getElementById(`group-${d.group_id}`).length
        ? `group-${d.group_id}` : null;
      node.move({ parent: parentId as unknown as string });
    });

    updateGroupStates(cy);
  }, []);

  // ── Sync devices ─────────────────────────────────────────────────────────────
  const syncDevices = useCallback((
    devs: Device[], currentTheme: Theme, showHid: boolean,
    showAuto: boolean, hiddenEdges: ReadonlySet<string>,
    wsGroupId: number | null, wsPositions: Record<string, {x: number; y: number}>,
  ) => {
    const cy = cyRef.current;
    if (!cy) return;
    devicesRef.current = devs;

    let visible = devs.filter(d => showHid || !d.hidden);
    const gwMAC = findGatewayMAC(visible);

    // Group-filtered workspace: show only the gateway + devices in this group
    if (wsGroupId !== null) {
      visible = visible.filter(d => d.mac === gwMAC || d.group_id === wsGroupId);
    }
    gatewayRef.current = gwMAC;

    const existing = new Set(cy.nodes().not('.group-node').map(n => n.id()));
    const incoming = new Set(visible.map(d => d.mac));
    cy.nodes().not('.group-node').forEach(n => { if (!incoming.has(n.id())) cy.remove(n); });

    let hasNew = false;
    visible.forEach(d => {
      const stateColor = STATE_COLOURS[d.state] ?? STATE_COLOURS.unknown;
      const nodeIcon   = ICONS[currentTheme][d.device_type] ?? ICONS[currentTheme].generic;
      const latency    = d.latency_ms != null && d.latency_ms > 0 && d.state === 'up' ? `\n${d.latency_ms}ms` : '';
      const label      = shortName(d) + latency;
      const isGateway  = d.mac === gwMAC;
      const parentId   = d.group_id != null && cy.getElementById(`group-${d.group_id}`).length
        ? `group-${d.group_id}` : null;

      if (existing.has(d.mac)) {
        const n = cy.getElementById(d.mac);
        n.data({ stateColor, icon: nodeIcon, label, isGateway });
        n.toggleClass('hidden-node', d.hidden);
        n.move({ parent: parentId as unknown as string });
      } else {
        const wsPos     = wsPositions[d.mac];
        // overviewPositionsRef is updated on every drag/scale — always fresher than
        // d.pos_x/pos_y which are frozen at snapshot time and never mutated in React state.
        const memPos    = overviewPositionsRef.current[d.mac];
        const globalPos = d.pos_x != null && d.pos_y != null ? { x: d.pos_x, y: d.pos_y } : null;
        const pos       = wsPos ?? memPos ?? globalPos ?? { x: Math.random() * 520 + 80, y: Math.random() * 400 + 80 };
        cy.add({ group: 'nodes', data: { id: d.mac, stateColor, icon: nodeIcon, label, isGateway, parent: parentId ?? undefined }, position: pos });
        if (d.hidden) cy.getElementById(d.mac).addClass('hidden-node');
        // Seed the Overview cache ONLY if not already present — never overwrite a
        // drag/scale-updated entry with a stale snapshot position.
        if (globalPos && !overviewPositionsRef.current[d.mac]) {
          overviewPositionsRef.current[d.mac] = globalPos;
        }
        hasNew = true;
      }
    });

    if (gwMAC) {
      cy.edges('.auto-edge').remove();
      if (showAuto) {
        visible.forEach(d => {
          if (d.mac === gwMAC || !cy.getElementById(d.mac).length) return;
          const key = autoEdgeKey(gwMAC, d.mac);
          if (hiddenEdges.has(key)) return;
          cy.add({ group: 'edges', data: { id: `ae-${d.mac}`, source: gwMAC, target: d.mac, edgeKey: key }, classes: 'auto-edge' });
        });
      }
    }

    if (hasNew) {
      // For the Overview (ws 1): auto-layout only if nothing has ever been positioned —
      // check both the snapshot data AND the in-memory cache (populated by drags/scale
      // and auto-layout, so it's always current even when d.pos_x/pos_y are stale).
      // For group workspaces: skip layout if workspace positions already exist.
      const anyPersisted = wsGroupId !== null
        ? Object.keys(wsPositions).length > 0
        : devs.some(d => d.pos_x != null && d.pos_y != null) ||
          Object.keys(overviewPositionsRef.current).length > 0;

      if (!anyPersisted) {
        runLayout(cy, gwMAC, false, () => {
          // Save positions immediately after auto-layout so subsequent loads are stable.
          const wsId = workspaceIdRef.current;
          cy.nodes().not('.group-node').forEach(n => {
            const p   = n.position();
            const url = wsId === 1
              ? `/api/devices/${encodeURIComponent(n.id())}/position`
              : `/api/workspaces/${wsId}/devices/${encodeURIComponent(n.id())}/position`;
            fetch(url, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ x: p.x, y: p.y }),
            }).catch(() => {});
            // Also update Overview cache
            if (wsId === 1) overviewPositionsRef.current[n.id()] = { x: p.x, y: p.y };
          });
        });
      }
    }

    updateGroupStates(cy);
  }, []);

  // ── Sync custom edges ────────────────────────────────────────────────────────
  const syncCustomEdges = useCallback((
    edges: CustomEdge[],
    colors: Record<number, string>,
    hiddenEdges: ReadonlySet<number>,
  ) => {
    const cy = cyRef.current;
    if (!cy) return;

    // Edges that should be on the map: exist AND not hidden
    const visibleIds = new Set(edges.filter(e => !hiddenEdges.has(e.id)).map(e => `ce-${e.id}`));
    cy.edges('.custom-edge').forEach(e => { if (!visibleIds.has(e.id())) cy.remove(e); });

    edges.forEach(e => {
      if (hiddenEdges.has(e.id)) return; // skip hidden
      const eid   = `ce-${e.id}`;
      const color = colors[e.id] ?? COLOR_PRESETS[0];
      // grp:{id} references resolve to compound node IDs (group-{id})
      const srcId = e.source_mac.startsWith('grp:') ? `group-${e.source_mac.slice(4)}` : e.source_mac;
      const tgtId = e.target_mac.startsWith('grp:') ? `group-${e.target_mac.slice(4)}` : e.target_mac;
      const edgeLabel = e.label || '';
      const node  = cy.getElementById(eid);
      if (node.length) { node.data('edgeColor', color); node.data('edgeLabel', edgeLabel); return; }
      if (!cy.getElementById(srcId).length || !cy.getElementById(tgtId).length) return;
      cy.add({ group: 'edges', data: { id: eid, source: srcId, target: tgtId, dbId: String(e.id), edgeColor: color, edgeLabel }, classes: 'custom-edge' });
    });
  }, []);

  // ── Effect ordering note ──────────────────────────────────────────────────
  // React runs effects in declaration order when deps change in the same render.
  // Correct order: syncDevices → syncGroups → syncCustomEdges
  // This ensures group nodes exist before we try to draw edges to them.

  useEffect(() => {
    syncDevices(devices, theme, showHidden, showAutoEdges, hiddenAutoEdges, workspaceGroupId, workspacePositions);
  }, [devices, theme, showHidden, showAutoEdges, hiddenAutoEdges, workspaceGroupId, workspacePositions, syncDevices]);

  // syncGroups must run before syncCustomEdges so group compound nodes exist
  // when custom edges try to reference them.
  useEffect(() => { syncGroups(groups, workspaceGroupId); }, [groups, workspaceGroupId, syncGroups]);

  // Deps include `devices`, `groups`, and `workspaceGroupId` so that edges are
  // retried whenever their endpoints become available (new device, group created,
  // workspace switch that adds nodes back to the canvas).
  useEffect(() => { syncCustomEdges(customEdges, edgeColors, hiddenCustomEdges); },
    [devices, groups, workspaceGroupId, customEdges, edgeColors, hiddenCustomEdges, syncCustomEdges]);

  // ── Workspace position restoration ──────────────────────────────────────────
  // Fires only when workspacePositions changes reference (i.e. on workspace switch).
  // Repositions already-rendered nodes to their saved positions for this workspace.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const ANIM_OPTS = { duration: 320, easing: 'ease-in-out-cubic' as const, queue: false };
    if (Object.keys(workspacePositions).length > 0) {
      // Non-Overview workspace: animate nodes to their saved positions.
      Object.entries(workspacePositions).forEach(([mac, pos]) => {
        const node = cy.getElementById(mac);
        if (node.length && !node.hasClass('group-node')) node.animate({ position: pos }, ANIM_OPTS);
      });
    } else {
      // Overview (or first load): animate back to cached Overview positions.
      Object.entries(overviewPositionsRef.current).forEach(([mac, pos]) => {
        const node = cy.getElementById(mac);
        if (node.length && !node.hasClass('group-node')) node.animate({ position: pos }, ANIM_OPTS);
      });
    }
  }, [workspacePositions]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    if (selectedMAC) cy.getElementById(selectedMAC).select();
  }, [selectedMAC]);

  // Auto-fit on any workspace switch (id change) or group filter change.
  // Delayed 220ms to let syncDevices + position restoration settle first.
  useEffect(() => {
    const t = setTimeout(() => { if (cyRef.current) cyAnimateFit(cyRef.current, 80); }, 220);
    return () => clearTimeout(t);
  }, [workspaceId, workspaceGroupId]);

  // ── Drag from device list ─────────────────────────────────────────────────
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const mac = e.dataTransfer.getData('device-mac');
    if (!mac) return;
    const cy = cyRef.current;
    if (!cy) return;
    const rect   = containerRef.current!.getBoundingClientRect();
    const modelX = (e.clientX - rect.left - cy.pan().x) / cy.zoom();
    const modelY = (e.clientY - rect.top  - cy.pan().y) / cy.zoom();
    const node   = cy.getElementById(mac);
    if (node.length) node.position({ x: modelX, y: modelY });
    else onToggleHidden(mac, false);
    const wsId  = workspaceIdRef.current;
    const posUrl = wsId === 1
      ? `/api/devices/${encodeURIComponent(mac)}/position`
      : `/api/workspaces/${wsId}/devices/${encodeURIComponent(mac)}/position`;
    fetch(posUrl, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: modelX, y: modelY }),
    }).catch(() => {});
  }

  // ── Map controls ─────────────────────────────────────────────────────────────
  function zoomAt(f: number) {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: (containerRef.current?.clientWidth ?? 600) / 2, y: (containerRef.current?.clientHeight ?? 400) / 2 } });
  }
  function fitAll()   { if (cyRef.current) cyAnimateFit(cyRef.current, 60); }
  function relayout() {
    const cy = cyRef.current;
    if (!cy || !cy.nodes().not('.group-node').length) return;
    const wsId = workspaceIdRef.current;
    runLayout(cy, gatewayRef.current, true, () => {
      cy.nodes().not('.group-node').forEach(n => {
        const p   = n.position();
        const url = wsId === 1
          ? `/api/devices/${encodeURIComponent(n.id())}/position`
          : `/api/workspaces/${wsId}/devices/${encodeURIComponent(n.id())}/position`;
        fetch(url, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: p.x, y: p.y }),
        }).catch(() => {});
      });
    });
  }

  function handleEdgeColorPick(color: string) {
    if (!edgeAction || edgeAction.kind !== 'custom') return;
    const id = edgeAction.id;
    const cy = cyRef.current;
    if (cy) cy.getElementById(`ce-${id}`).data('edgeColor', color);
    cbEdgeColor.current(id, color);
    setEdgeAction({ ...edgeAction, currentColor: color });
  }

  function handleEdgeLabelCommit(label: string) {
    if (!edgeAction || edgeAction.kind !== 'custom') return;
    const id = edgeAction.id;
    const cy = cyRef.current;
    if (cy) cy.getElementById(`ce-${id}`).data('edgeLabel', label);
    fetch(`/api/edges/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }).catch(() => {});
    setEdgeAction({ ...edgeAction, currentLabel: label });
  }

  // ── Scale-overlay drag ───────────────────────────────────────────────────────
  function handleScaleStart(e: React.MouseEvent, h: HandleDef) {
    e.preventDefault();
    e.stopPropagation();
    const cy = cyRef.current;
    const bb = computeSelBBRef.current?.();
    if (!cy || !bb) return;

    const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
    const handleMX = lerpN(bb.mx1, bb.mx2, h.px);
    const handleMY = lerpN(bb.my1, bb.my2, h.py);
    const anchorMX = lerpN(bb.mx1, bb.mx2, h.ax);
    const anchorMY = lerpN(bb.my1, bb.my2, h.ay);

    // Collect leaf nodes (skip compound group nodes; scale their children)
    const snapshots: { el: NodeSingular; x: number; y: number }[] = [];
    const seen = new Set<string>();
    const visit = (n: NodeSingular) => {
      if (seen.has(n.id())) return;
      seen.add(n.id());
      if (n.hasClass('group-node')) {
        n.children().not('.group-node').forEach(c => visit(c as NodeSingular));
      } else {
        snapshots.push({ el: n, x: n.position('x'), y: n.position('y') });
      }
    };
    cy.$(':selected').filter('node').forEach(n => visit(n as NodeSingular));

    const startCX = e.clientX, startCY = e.clientY;

    const moveHandler = (me: MouseEvent) => {
      const z = cy.zoom();
      const dx = (me.clientX - startCX) / z;
      const dy = (me.clientY - startCY) / z;
      let sX = 1, sY = 1;
      if (h.sx && Math.abs(handleMX - anchorMX) > 0.5)
        sX = Math.max(0.15, Math.min(8, (handleMX + dx - anchorMX) / (handleMX - anchorMX)));
      if (h.sy && Math.abs(handleMY - anchorMY) > 0.5)
        sY = Math.max(0.15, Math.min(8, (handleMY + dy - anchorMY) / (handleMY - anchorMY)));
      snapshots.forEach(({ el, x, y }) =>
        el.position({ x: anchorMX + (x - anchorMX) * sX, y: anchorMY + (y - anchorMY) * sY })
      );
    };

    const endHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup',   endHandler);
      document.body.style.cursor = '';
      cy.userPanningEnabled(true);
      cy.userZoomingEnabled(true);
      // Persist final positions
      const wsId = workspaceIdRef.current;
      snapshots.forEach(({ el }) => {
        const pos = el.position();
        const mac = el.id();
        const url = wsId === 1
          ? `/api/devices/${encodeURIComponent(mac)}/position`
          : `/api/workspaces/${wsId}/devices/${encodeURIComponent(mac)}/position`;
        fetch(url, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: pos.x, y: pos.y }),
        }).catch(() => {});
        if (wsId === 1) overviewPositionsRef.current[mac] = { x: pos.x, y: pos.y };
      });
    };

    cy.userPanningEnabled(false);
    cy.userZoomingEnabled(false);
    document.body.style.cursor = h.cursor;
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup',   endHandler);
  }

  const hiddenCount = hiddenAutoEdges.size;

  return (
    <div
      style={{ position: 'relative', width: '100%', flex: 1, minHeight: 0 }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={e => e.preventDefault()}
    >
      <div ref={containerRef} className={`topology-map ${connectingMAC ? 'cursor-crosshair' : ''}`} />

      {/* Back-to-Overview indicator — visible whenever we're in a sub-workspace */}
      {workspaceId !== 1 && (
        <button
          className="ws-back-badge"
          onClick={onGoToOverview}
          title="Return to Overview (or tap empty canvas)"
        >
          ← Overview
        </button>
      )}

      {connectingMAC && (
        <div className="connect-banner">
          Click another device to draw a connection · <kbd>Esc</kbd> to cancel
        </div>
      )}

      {/* Selection scale overlay — shown for multi-select or single group */}
      {selBB && !connectingMAC && (() => {
        const lerpS = (a: number, b: number, t: number) => a + (b - a) * t;
        return (
          <>
            <div className="sel-scale-box" style={{
              left:   selBB.left,
              top:    selBB.top,
              width:  selBB.right  - selBB.left,
              height: selBB.bottom - selBB.top,
            }} />
            {SCALE_HANDLES.map(h => (
              <div
                key={h.id}
                className="sel-scale-handle"
                style={{
                  left:   lerpS(selBB.left, selBB.right,  h.px),
                  top:    lerpS(selBB.top,  selBB.bottom, h.py),
                  cursor: h.cursor,
                }}
                onMouseDown={e => handleScaleStart(e, h)}
              />
            ))}
          </>
        );
      })()}

      {/* Edge action bar */}
      {edgeAction && (
        <div className="edge-action-bar" style={{ left: edgeAction.x, top: Math.max(8, edgeAction.y - 60) }}>
          <span className="edge-action-label">{edgeAction.label}</span>

          {edgeAction.kind === 'custom' && (<>
            <input
              className="edge-label-input"
              placeholder="Add label…"
              defaultValue={edgeAction.currentLabel}
              onBlur={e  => handleEdgeLabelCommit(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { handleEdgeLabelCommit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') setEdgeAction(null); }}
              onClick={e => e.stopPropagation()}
            />
            <div className="edge-color-swatches">
              {COLOR_PRESETS.map(c => (
                <button
                  key={c}
                  className={`edge-color-swatch ${edgeAction.currentColor === c ? 'edge-color-swatch--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => handleEdgeColorPick(c)}
                  title={c}
                />
              ))}
            </div>
          </>)}

          {edgeAction.kind === 'auto' ? (
            <button className="edge-action-btn edge-action-btn--danger" onClick={() => { onHideAutoEdge(edgeAction.edgeKey); setEdgeAction(null); }}>
              Hide line
            </button>
          ) : (
            <button className="edge-action-btn edge-action-btn--danger" onClick={() => { onDeleteEdge(edgeAction.id); setEdgeAction(null); }}>
              🗑 Delete
            </button>
          )}
          <button className="edge-action-btn" onClick={() => setEdgeAction(null)}>✕</button>
        </div>
      )}

      <div className="map-controls">
        <button className="map-btn" onClick={() => zoomAt(1.3)} title="Zoom in">+</button>
        <button className="map-btn" onClick={fitAll}             title="Fit all">⊡</button>
        <button className="map-btn" onClick={() => zoomAt(0.77)} title="Zoom out">−</button>
        <div className="map-controls-divider" />
        <button className="map-btn" onClick={relayout} title="Auto-layout">⟳</button>
        <div className="map-controls-divider" />
        <button
          className={`map-btn ${!showAutoEdges ? 'map-btn--off' : ''}`}
          onClick={onToggleAutoEdges}
          title={showAutoEdges ? 'Hide auto-connections' : 'Show auto-connections'}
        >
          ⌁
        </button>
        {hiddenCount > 0 && (
          <button className="map-btn map-btn--warn" onClick={onShowAllEdges} title={`${hiddenCount} line${hiddenCount !== 1 ? 's' : ''} hidden — restore all`}>
            {hiddenCount}↺
          </button>
        )}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortName(d: Device): string {
  const n = d.label || (d.hostname && !/^\d{1,3}(\.\d{1,3}){3}$/.test(d.hostname) ? d.hostname.split('.')[0] : null) || d.ip;
  return n.length > 16 ? n.slice(0, 15) + '…' : n;
}

function runLayout(cy: Core, gwMAC: string | null, animate: boolean, onDone?: () => void) {
  const opts = gwMAC
    ? ({ name: 'breadthfirst', animate, animationDuration: 500, fit: true, padding: 80, directed: false, roots: cy.getElementById(gwMAC), spacingFactor: 1.7, avoidOverlap: true } as cytoscape.LayoutOptions)
    : ({ name: 'cose', animate, animationDuration: 500, fit: true, padding: 80, nodeRepulsion: () => 14000, nodeDimensionsIncludeLabels: true, gravity: 40, numIter: 1500 } as cytoscape.LayoutOptions);
  const layout = cy.layout(opts);
  if (onDone) layout.one('layoutstop', onDone);
  layout.run();
}

/** Smoothly pan+zoom the viewport to fit all visible elements. */
function cyAnimateFit(cy: Core, padding = 80, duration = 380) {
  const eles = cy.elements(':visible');
  if (!eles.length) return;
  cy.animate({ fit: { eles, padding } } as cytoscape.AnimateOptions, {
    duration,
    easing: 'ease-in-out-cubic',
    queue: false,
  });
}
