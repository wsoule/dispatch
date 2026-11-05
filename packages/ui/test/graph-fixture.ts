import type { GraphEdgeData, GraphNodeData } from '../src/graph/types';

// The gallery's milestone-level graph in miniature (the gallery lives in
// the planner app, which the package tests cannot import): five projects,
// an overdue cutover holding up two milestones, a risk chain from an
// unassigned Search milestone, a 2-cycle in Identity, resolved edges and
// aggregated weights.

function node(
  id: string,
  label: string,
  sublabel: string,
  extra: Partial<GraphNodeData> = {}
): GraphNodeData {
  return { id, label, sublabel, tone: 'default', status: 'on_track', ...extra };
}

export const MILESTONES: GraphNodeData[] = [
  node('atlas-m2', 'M2 Schema freeze', 'Atlas · done Oct 9', {
    tone: 'muted',
    status: 'done',
    group: 'Atlas',
  }),
  node('atlas-m3', 'M3 Cutover', 'Atlas · due Oct 18 · 3d over', {
    status: 'overdue',
    statusLabel: 'Overdue',
    tags: ['Overdue'],
    group: 'Atlas',
  }),
  node('atlas-m4', 'M4 Decommission legacy', 'Atlas · due Nov 12', {
    status: 'at_risk',
    group: 'Atlas',
  }),
  node('billing-m0', 'Payments SDK 3', 'Billing · done Oct 2', {
    tone: 'muted',
    status: 'done',
    group: 'Billing',
  }),
  node('billing-m1', 'Invoices v2', 'Billing · due Oct 30', {
    status: 'at_risk',
    group: 'Billing',
  }),
  node('billing-m2', 'Dunning emails', 'Billing · due Nov 20', {
    group: 'Billing',
  }),
  node('search-m1', 'Index rebuild', 'Search · due Nov 2 · no lead', {
    tone: 'warning',
    status: 'at_risk',
    tags: ['Unassigned'],
    group: 'Search',
  }),
  node('search-m2', 'Ranking v3', 'Search · no target date', {
    status: 'missing',
    group: 'Search',
  }),
  node('mobile-m1', 'Offline sync', 'Mobile · due Nov 5', {
    status: 'at_risk',
    group: 'Mobile',
  }),
  node('mobile-m2', 'Store release 4.2', 'Mobile · due Nov 26', {
    group: 'Mobile',
  }),
  node('identity-m1', 'SSO rollout', 'Identity · due Nov 9', {
    tags: ['Cycle'],
    group: 'Identity',
  }),
  node('identity-m2', 'Audit log export', 'Identity · due Nov 16', {
    tags: ['Cycle'],
    group: 'Identity',
  }),
];

export const MILESTONE_EDGES: GraphEdgeData[] = [
  { from: 'atlas-m2', to: 'atlas-m3', kind: 'resolved', weight: 2 },
  { from: 'atlas-m3', to: 'atlas-m4', kind: 'risk', weight: 3 },
  { from: 'atlas-m3', to: 'billing-m1', kind: 'risk', weight: 2 },
  { from: 'billing-m0', to: 'mobile-m1', kind: 'resolved' },
  { from: 'billing-m1', to: 'billing-m2', kind: 'risk' },
  { from: 'search-m1', to: 'mobile-m1', kind: 'risk', weight: 4 },
  { from: 'search-m1', to: 'search-m2', kind: 'risk' },
  { from: 'mobile-m1', to: 'mobile-m2', kind: 'risk' },
  { from: 'identity-m1', to: 'identity-m2', kind: 'cycle' },
  { from: 'identity-m2', to: 'identity-m1', kind: 'cycle' },
  { from: 'identity-m1', to: 'mobile-m2', kind: 'cross' },
  { from: 'identity-m2', to: 'atlas-m4', kind: 'cross', weight: 2 },
];

/** Issue level with external one-hop nodes and a long, wrapping title. */
export const ISSUES: GraphNodeData[] = [
  node('ATL-41', 'Freeze writes on legacy DB', 'ATL-41 · Ana', {
    tone: 'muted',
    status: 'done',
  }),
  node('ATL-42', 'Dual-write shim', 'ATL-42 · Ben', { tags: ['Overdue'] }),
  node('ATL-43', 'Backfill orders table', 'ATL-43 · unassigned', {
    tone: 'warning',
    tags: ['Unassigned', 'Overdue'],
  }),
  node(
    'ATL-44',
    'Switch the read path over to the new cluster and drain the old one',
    'ATL-44 · Ana',
    { tags: ['Overdue'] }
  ),
  node('PLT-7', 'Provision read replica', 'Platform · PLT-7 · done', {
    external: true,
    status: 'done',
  }),
  node('BIL-12', 'Invoice ID migration', 'Billing · BIL-12 · Dana', {
    external: true,
  }),
];

export const ISSUE_EDGES: GraphEdgeData[] = [
  { from: 'ATL-41', to: 'ATL-42', kind: 'resolved' },
  { from: 'PLT-7', to: 'ATL-42', kind: 'resolved' },
  { from: 'ATL-42', to: 'ATL-43', kind: 'risk' },
  { from: 'BIL-12', to: 'ATL-43', kind: 'cross' },
  { from: 'ATL-43', to: 'ATL-44', kind: 'risk' },
];
