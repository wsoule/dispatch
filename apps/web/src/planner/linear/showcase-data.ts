// The tables behind the showcase demo workspace (showcase.ts,
// LINEAR_FIXTURE=showcase): the base Northwind Labs workspace grown into a
// mid-size product company. Everything here is added to the base workspace
// (fixture.ts), which stays unchanged inside it. Fictional throughout.
//
// The milestone, issue and relation tables are plain text, one row per
// line, so 350 issues stay readable (and the formatter leaves them alone);
// showcase.ts parses them and throws on a row that does not resolve. The
// design (why each hub, chain and cycle exists, and the flow rules that
// keep the graph readable) is in docs/architecture.md §4, "Showcase demo
// workspace".

import type {
  EstimateScale,
  Priority,
  ProjectStatusType,
} from '@dispatch/planning';

import type { FixtureLabel } from './fixture-details.js';

/** People who joined since the base workspace (all active members). */
export const SHOWCASE_PEOPLE: readonly { id: string; name: string }[] = [
  { id: 'user-iris', name: 'Iris Okafor' },
  { id: 'user-jonas', name: 'Jonas Berg' },
  { id: 'user-kai', name: 'Kai Tanaka' },
  { id: 'user-theo', name: 'Theo Lambert' },
  { id: 'user-lena', name: 'Lena Fischer' },
  { id: 'user-marco', name: 'Marco Bianchi' },
  { id: 'user-priya', name: 'Priya Raman' },
  { id: 'user-uma', name: 'Uma Kapoor' },
  { id: 'user-nadia', name: 'Nadia Haddad' },
  { id: 'user-quinn', name: 'Quinn Avery' },
  { id: 'user-rosa', name: 'Rosa Alvarez' },
  { id: 'user-omar', name: 'Omar Farouk' },
];

/** Who joined the two base teams (appended to their member lists). */
export const SHOWCASE_EXTRA_MEMBERS: Readonly<Record<string, string[]>> = {
  'team-eng': ['user-iris', 'user-jonas', 'user-kai', 'user-theo'],
  'team-ops': ['user-omar', 'user-rosa'],
};

/** The two new teams, public like the base ones; the guest is in neither. */
export const SHOWCASE_TEAMS: readonly {
  key: string;
  name: string;
  memberIds: string[];
}[] = [
  {
    key: 'data',
    name: 'Data',
    memberIds: [
      'user-dev',
      'user-lena',
      'user-marco',
      'user-priya',
      'user-uma',
    ],
  },
  {
    key: 'gro',
    name: 'Growth',
    memberIds: [
      'user-ben',
      'user-chloe',
      'user-nadia',
      'user-quinn',
      'user-rosa',
      'user-uma',
    ],
  },
];

/** Two more initiatives; with the base two they rank Platform first. */
export const SHOWCASE_INITIATIVES: readonly {
  id: string;
  name: string;
  sortOrder: number;
  priority: Priority;
  /** Days from today. */
  target: number;
}[] = [
  {
    id: 'init-enterprise',
    name: 'Enterprise readiness',
    sortOrder: 3,
    priority: 2,
    target: 70,
  },
  {
    id: 'init-insights',
    name: 'Self-serve insights',
    sortOrder: 4,
    priority: 2,
    target: 100,
  },
];

/** A new project; dates are days from today. */
export interface ShowcaseProjectSpec {
  key: string;
  name: string;
  status: ProjectStatusType;
  leadId: string | null;
  priority: Priority;
  initiativeIds: string[];
  teams: string[];
  start: number | null;
  target: number | null;
}

// The new projects, after the base nine in sort order. Each project's home
// (first initiative by rank) is the first id listed.
export const SHOWCASE_PROJECTS: readonly ShowcaseProjectSpec[] = [
  {
    key: 'ridge',
    name: 'Ridge multi-region',
    status: 'started',
    leadId: 'user-elena',
    priority: 1,
    initiativeIds: ['init-platform', 'init-enterprise'],
    teams: ['eng', 'ops'],
    start: -35,
    target: 60,
  },
  {
    key: 'thistle',
    name: 'Thistle incidents',
    status: 'started',
    leadId: 'user-omar',
    priority: 2,
    initiativeIds: ['init-platform'],
    teams: ['ops'],
    start: -25,
    target: 40,
  },
  {
    key: 'lagoon',
    name: 'Lagoon SSO and SCIM',
    status: 'started',
    leadId: 'user-iris',
    priority: 1,
    initiativeIds: ['init-enterprise'],
    teams: ['eng', 'ops'],
    start: -40,
    target: 52,
  },
  {
    key: 'marble',
    name: 'Marble audit log',
    status: 'started',
    leadId: 'user-jonas',
    priority: 2,
    initiativeIds: ['init-enterprise'],
    teams: ['eng'],
    start: -30,
    target: 45,
  },
  {
    key: 'nettle',
    name: 'Nettle permissions v2',
    status: 'started',
    leadId: 'user-theo',
    priority: 2,
    initiativeIds: ['init-enterprise'],
    teams: ['eng'],
    start: -20,
    target: 50,
  },
  {
    key: 'orchard',
    name: 'Orchard data warehouse',
    status: 'started',
    leadId: 'user-priya',
    priority: 2,
    initiativeIds: ['init-insights'],
    teams: ['data'],
    start: -50,
    target: 46,
  },
  {
    key: 'plume',
    name: 'Plume event pipeline',
    status: 'started',
    leadId: 'user-marco',
    priority: 1,
    initiativeIds: ['init-insights'],
    teams: ['data', 'eng'],
    start: -45,
    target: 30,
  },
  {
    key: 'quarry',
    name: 'Quarry reports',
    status: 'planned',
    leadId: 'user-lena',
    priority: 3,
    initiativeIds: ['init-insights', 'init-growth'],
    teams: ['data', 'gro'],
    start: -5,
    target: 75,
  },
  {
    key: 'saffron',
    name: 'Saffron pricing',
    status: 'started',
    leadId: 'user-nadia',
    priority: 1,
    initiativeIds: ['init-enterprise', 'init-growth'],
    teams: ['gro', 'eng'],
    start: -25,
    target: 60,
  },
  {
    key: 'umber',
    name: 'Umber lifecycle email',
    status: 'started',
    leadId: 'user-quinn',
    priority: 3,
    initiativeIds: ['init-growth'],
    teams: ['gro'],
    start: -18,
    target: 65,
  },
  {
    key: 'willow',
    name: 'Willow help center',
    status: 'started',
    leadId: 'user-rosa',
    priority: 3,
    initiativeIds: [],
    teams: ['ops', 'gro'],
    start: -15,
    target: 68,
  },
  {
    key: 'sorrel',
    name: 'Sorrel partners',
    status: 'backlog',
    leadId: 'user-nadia',
    priority: 4,
    initiativeIds: ['init-growth'],
    teams: ['gro', 'eng'],
    start: 20,
    target: 120,
  },
];

// Milestones: `key | due | timing | done means source | name | text`.
//  key     ms-<key> is the id; the project is the key without "-<n>"
//  due     days from today, or "-" for no target date
//  timing  how unlisted issue timestamps are derived (showcase.ts):
//          done = finished before a past due date, live = normal work,
//          stalled = nothing moved for 9+ days
//  source  meta = the planner's "done means…" (SHOWCASE_MILESTONE_META),
//          desc = "Done means: <text>" in the Linear description,
//          none = no "done means…" anywhere (<text> is the description)
export const MILESTONE_TABLE = `
# Base projects, grown
atlas-4    | 55  | live    | meta | Legacy ledger shutdown       | The legacy ledger is read-only and scheduled for deletion.
beacon-3   | 60  | live    | meta | Personalized ranking         | Signed-in users get personalized results with a measured lift in clicks.
beacon-4   | -25 | done    | meta | Search v2 alpha              | Internal users search the catalog on the v2 index.
delta-2    | 34  | live    | desc | Scheduled exports            | admins can schedule any export daily or weekly.
ember-2    | 38  | live    | meta | In-app inbox                 | Every digest item also appears in the in-app inbox.
garnet-3   | 45  | live    | meta | Tablet layout                | The app is usable on tablets in both orientations.
garnet-4   | -28 | done    | meta | Offline prototype            | A prototype survives a day offline in a field test.
harbor-3   | 48  | live    | desc | SDK refresh                  | the JavaScript and Python SDKs cover every v3 endpoint.
harbor-4   | -13 | done    | meta | v3 design review             | The v3 API design is reviewed with partners and frozen.
juniper-3  | -   | live    | meta | Docs site                    | Every component has a documented page with live examples.
juniper-4  | -8  | done    | meta | Design audit                 | Every product surface is audited against the new tokens.

# Ridge multi-region (Platform reliability)
ridge-1    | -18 | done    | meta | Region-aware routing         | Every request is routed to the workspace's home region.
ridge-2    | -4  | live    | meta | EU data residency            | EU workspaces store and process data in the EU region only.
ridge-3    | 16  | live    | meta | Failover drills              | A production region fails over in under 15 minutes in a scheduled drill.
ridge-4    | 52  | live    | meta | Second region GA             | Any new workspace can choose its region at sign-up.

# Thistle incidents (Platform reliability)
thistle-1  | -10 | done    | meta | Paging rotation              | Every service has a paging rotation with a secondary.
thistle-2  | 3   | stalled | meta | Status page                  | Customers see incidents on a public status page within five minutes.
thistle-3  | 27  | live    | desc | Postmortem templates         | every Sev 1 and Sev 2 has a postmortem within five working days.

# Lagoon SSO and SCIM (Enterprise readiness)
lagoon-1   | -14 | done    | meta | SAML connector               | Admins can sign in through any SAML 2.0 identity provider.
lagoon-2   | 6   | live    | meta | OIDC and SAML GA             | Every plan above Team can turn on SSO without contacting support.
lagoon-3   | 24  | live    | meta | SCIM provisioning            | Users and groups sync from the identity provider within a minute.
lagoon-4   | 50  | live    | meta | Enterprise hardening         | The penetration test and the security questionnaire have no open findings.

# Marble audit log (Enterprise readiness)
marble-1   | -12 | done    | meta | Audit event schema           | Every audited action has one documented event type.
marble-2   | 12  | live    | meta | Audit log UI                 | Admins can search and filter a year of audit events.
marble-3   | 40  | live    | desc | Export and retention         | audit events are kept for the plan's retention period and can be exported.

# Nettle permissions v2 (Enterprise readiness)
nettle-1   | 2   | live    | meta | Role model                   | Every permission check goes through the new role model.
nettle-2   | 30  | live    | meta | Custom roles                 | Admins can create, assign and audit custom roles.
nettle-3   | -   | live    | none | Permission insights          | Who-can-see-what reports for admins; dated once custom roles ship.

# Orchard data warehouse (Self-serve insights)
orchard-1  | -30 | done    | meta | Warehouse foundations        | Product data lands in the warehouse every hour.
orchard-2  | -12 | done    | meta | Nightly loads                | Nightly loads finish before 06:00 UTC with row-count checks.
orchard-3  | 9   | live    | meta | Semantic layer               | Metrics are defined once and used by every report.
orchard-4  | 44  | live    | meta | Cost controls                | Warehouse spend has a budget and alerts per team.

# Plume event pipeline (Self-serve insights)
plume-1    | -22 | done    | meta | Event schema v2              | Every product event has a versioned schema with an owner.
plume-2    | -6  | live    | meta | Streaming ingestion          | Events reach the warehouse within five minutes.
plume-3    | 20  | live    | meta | Replay and backfill          | Any day of events can be replayed without duplicates.

# Quarry reports (Self-serve insights, planned)
quarry-1   | 18  | live    | meta | Report builder alpha         | Ten design partners build their own reports without help.
quarry-2   | 46  | live    | meta | Scheduled reports            | Any report can be emailed on a schedule.
quarry-3   | -   | live    | meta | Embedded dashboards          | Customers can embed a dashboard in their own tools.

# Saffron pricing (Enterprise readiness, also Customer growth)
saffron-1  | -9  | done    | meta | Plan catalog                 | Every plan and add-on is defined in one catalog.
saffron-2  | 5   | live    | meta | Usage-based billing          | Seats and usage are billed from metered events.
saffron-3  | 44  | live    | meta | Enterprise plan              | Enterprise customers can buy the plan without a sales call.
saffron-4  | 58  | live    | meta | Enterprise launch            | The enterprise plan is announced and on sale.

# Umber lifecycle email (Customer growth)
umber-1    | 1   | live    | meta | Event-triggered emails       | Lifecycle emails go out from product events within an hour.
umber-2    | 63  | live    | none | Enterprise onboarding emails | A welcome series for new enterprise workspaces.

# Willow help center (no initiative)
willow-1   | 7   | live    | none | Help center launch           | Move every help article to the new help center.
willow-2   | 66  | live    | meta | Contextual help              | Every settings page links to its help article.
willow-3   | -   | live    | none | Community forum              | Empty until the forum vendor is chosen.

# Sorrel partners (Customer growth, Backlog: inactive)
sorrel-1   | 62  | live    | meta | Partner API                  | Partners can build integrations against a stable API.
sorrel-2   | -   | live    | none | Marketplace listing          | Listing pages for partner apps.
sorrel-3   | 90  | live    | none | Revenue share                | Payouts to partners.
`;

/** Weight overrides the planner starts with (besides the base one). */
export const SHOWCASE_WEIGHTS: Readonly<Record<string, number>> = {
  'ms-lagoon-2': 3,
  'ms-saffron-4': 2,
};

// Issues: `ID milestone assignee state priority title`.
//  milestone  a MILESTONE_TABLE key, "<project>:" for a project issue
//             with no milestone, or "-" for no project (open issues only:
//             the real sync mirrors no closed project-less issue)
//  assignee   a first name (user-<name>), or "-" for unassigned
//  state      tr triage, bl backlog, td todo, ip in progress, rv in
//             review, dn done, cx canceled, du duplicate
// Created and changed dates come from the milestone's timing profile
// (showcase.ts, deriveTiming).
export const ISSUE_TABLE = `
# --- Base milestones, grown (base issues stay as they are) ---------------
ENG-106  atlas-3    dev    td 2 Ledger read replicas
ENG-107  atlas-3    -      bl 3 Parity dashboard for finance
ENG-115  beacon-2   dev    bl 2 Search v2 load test
ENG-116  beacon-2   grace  bl 3 Search filters redesign
ENG-117  beacon-2   -      bl 4 Search keyboard shortcuts
ENG-125  compass-2  -      bl 3 Invite by link
ENG-126  compass-2  ana    bl 3 Bulk invite from CSV
OPS-45   compass-2  -      bl 4 Invite email deliverability check
OPS-46   compass-3  -      bl 4 Glossary for translators
OPS-47   delta-1    femi   td 3 Export column picker
OPS-48   delta-1    -      bl 4 Export file naming
ENG-127  ember-1    grace  td 3 Digest unsubscribe link
ENG-128  ember-1    -      bl 3 Digest preview in settings
ENG-146  harbor-2   elena  bl 2 v3 default for new API keys
ENG-147  harbor-2   -      bl 3 v2 traffic dashboard
ENG-148  harbor-2   ben    bl 3 v3 changelog page
ENG-158  juniper-1  grace  bl 3 Spacing scale
ENG-154  juniper-2  grace  bl 3 Select and combobox components
ENG-155  juniper-2  -      bl 3 Table component
ENG-156  juniper-2  ana    bl 4 Component usage tracking

# --- Atlas billing migration ---------------------------------------------
ENG-100  atlas-4    -      bl 2 Freeze writes to the legacy ledger
ENG-101  atlas-4    dev    bl 3 Archive legacy invoices to cold storage
ENG-102  atlas-4    chloe  td 3 Remove dual-write code paths
ENG-103  atlas-4    -      bl 2 Decommission the legacy ledger database
ENG-104  atlas-4    elena  bl 4 Update finance runbooks for the new ledger
ENG-105  atlas-4    -      bl 4 Ledger cost review after shutdown
ENG-109  atlas-4    chloe  dn 3 Legacy ledger usage audit
ENG-108  atlas:     -      bl 4 Ledger query cleanup

# --- Beacon search -------------------------------------------------------
ENG-86   beacon-4   dev    dn 1 Search index pipeline
ENG-87   beacon-4   dev    dn 2 Query DSL
ENG-88   beacon-4   ana    dn 2 Relevance test set
ENG-89   beacon-4   grace  dn 3 Search results page prototype
ENG-90   beacon-4   ana    dn 3 Alpha customer interviews
ENG-91   beacon-4   dev    cx 4 Vector search spike
ENG-110  beacon-3   dev    bl 2 Ranking feature store client
ENG-111  beacon-3   -      bl 2 Personalized ranking model integration
ENG-112  beacon-3   ana    bl 3 Ranking A/B experiment
ENG-113  beacon-3   -      bl 3 Search relevance dashboard
ENG-114  beacon-3   grace  bl 3 Opt-out for personalized results
ENG-119  beacon-3   ana    dn 3 Personalization privacy review
ENG-118  beacon:    -      tr 0 Request: search inside attachments

# --- Delta exports (no lead) ---------------------------------------------
OPS-40   delta-2    femi   bl 2 Export scheduler
OPS-41   delta-2    -      bl 3 Export delivery by email
OPS-42   delta-2    -      bl 3 Export history page
OPS-43   delta-2    femi   td 2 Stream large exports
OPS-44   delta-2    -      bl 3 Export failure alerts
OPS-49   delta-2    femi   dn 3 Export scheduler design

# --- Ember notifications (deactivated lead) ------------------------------
ENG-120  ember-2    grace  bl 2 Inbox data model
ENG-121  ember-2    -      bl 3 Inbox panel
ENG-122  ember-2    -      bl 3 Mark as read across devices
ENG-123  ember-2    grace  bl 3 Notification preferences page
ENG-124  ember-2    chloe  bl 4 Unread badge in the sidebar
ENG-129  ember-2    grace  dn 3 Inbox design spec

# --- Garnet mobile app (no initiative) -----------------------------------
ENG-92   garnet-4   ben    dn 1 Local database spike
ENG-93   garnet-4   kai    dn 2 Sync protocol draft
ENG-94   garnet-4   ben    dn 2 Offline prototype build
ENG-95   garnet-4   ana    dn 3 Offline user research
ENG-130  garnet-3   kai    bl 3 Split-view navigation
ENG-131  garnet-3   -      bl 4 Tablet keyboard shortcuts
ENG-132  garnet-3   kai    bl 3 Landscape layouts for detail screens
ENG-133  garnet-3   -      bl 4 Tablet QA matrix
ENG-134  garnet-3   kai    bl 4 Drag and drop between panes
ENG-135  garnet-3   kai    dn 3 Tablet layout research

# --- Harbor API v3 -------------------------------------------------------
ENG-81   harbor-4   elena  dn 1 v3 resource model
ENG-82   harbor-4   ben    dn 2 v3 error format
ENG-83   harbor-4   elena  dn 2 v3 pagination design
ENG-84   harbor-4   theo   dn 3 v3 design review with partners
ENG-85   harbor-4   ben    cx 4 GraphQL gateway spike
ENG-140  harbor-3   elena  bl 2 Generate SDKs from the v3 spec
ENG-141  harbor-3   -      bl 3 JavaScript SDK release
ENG-142  harbor-3   -      bl 3 Python SDK release
ENG-143  harbor-3   ben    bl 3 SDK migration guide
ENG-144  harbor-3   -      bl 4 Deprecation notices in the v2 SDKs
ENG-145  harbor-3   theo   td 3 SDK smoke tests in CI
ENG-149  harbor-3   elena  dn 3 SDK generator evaluation

# --- Juniper design system -----------------------------------------------
ENG-96   juniper-4  grace  dn 2 Audit every product surface
ENG-97   juniper-4  ana    dn 3 Color contrast review
ENG-98   juniper-4  grace  dn 3 Design token proposal
ENG-99   juniper-4  -      cx 4 Icon set comparison
ENG-150  juniper-3  grace  bl 3 Docs site scaffold
ENG-151  juniper-3  -      bl 4 Live code examples
ENG-152  juniper-3  -      bl 4 Usage guidelines for forms
ENG-153  juniper-3  ana    bl 3 Accessibility notes per component
ENG-157  juniper-3  grace  dn 4 Docs site hosting choice

# --- Ridge multi-region --------------------------------------------------
ENG-160  ridge-1    elena  dn 2 Region field on workspaces
ENG-161  ridge-1    jonas  dn 1 Edge routing by region
ENG-162  ridge-1    elena  dn 2 Region-aware session store
OPS-50   ridge-1    omar   dn 2 Provision the second region's network
OPS-51   ridge-1    omar   dn 3 Cross-region VPN
ENG-163  ridge-1    jonas  cx 3 Routing load test
ENG-164  ridge-2    elena  ip 1 Pin EU workspaces to the EU region
ENG-165  ridge-2    jonas  rv 2 Residency checks on file uploads
OPS-52   ridge-2    -      bl 1 Second region capacity plan
OPS-53   ridge-2    omar   ip 2 In-region backups for the EU
ENG-166  ridge-2    -      td 3 Residency report for customers
ENG-167  ridge-2    elena  td 1 Migrate existing EU workspaces
OPS-54   ridge-2    rosa   dn 3 Update the data processing addendum
ENG-168  ridge-2    theo   dn 4 Region badge in workspace settings
OPS-55   ridge-3    omar   td 2 Failover drill plan
OPS-56   ridge-3    -      bl 2 Automated DNS failover
ENG-169  ridge-3    jonas  ip 2 Replication lag alerts
ENG-170  ridge-3    elena  td 2 Read-only mode during failover
OPS-57   ridge-3    omar   bl 1 First scheduled failover drill
ENG-171  ridge-3    -      bl 3 Failover game-day checklist
OPS-58   ridge-3    -      bl 3 Review the drill results
OPS-62   ridge-3    omar   dn 3 Failover drill calendar
OPS-63   ridge-3    -      bl 4 Customer notice template for drills
ENG-172  ridge-4    theo   bl 2 Region picker at sign-up
ENG-173  ridge-4    dev    bl 2 Cross-region search index
OPS-59   ridge-4    -      bl 2 On-call coverage for the second region
ENG-174  ridge-4    -      bl 3 Region-aware billing exports
OPS-60   ridge-4    rosa   bl 4 Announce the second region
ENG-175  ridge-4    jonas  bl 3 Latency SLO dashboards per region
ENG-159  ridge-4    -      bl 4 Region status on the status page
ENG-176  ridge:     -      tr 0 Request: a region in Australia
OPS-61   ridge:     omar   td 3 Second region cost estimate

# --- Thistle incidents ---------------------------------------------------
OPS-70   thistle-1  omar   dn 2 Paging rotation for every service
OPS-71   thistle-1  ben    dn 2 Escalation policy
OPS-72   thistle-1  omar   dn 3 Migrate to the new pager tool
OPS-74   thistle-1  ana    dn 4 On-call compensation policy
OPS-75   thistle-1  ben    cx 4 Rotation calendar sync
OPS-76   thistle-2  rosa   ip 2 Public status page
OPS-77   thistle-2  ben    td 3 Incident templates for the status page
OPS-78   thistle-2  omar   td 3 Status page subscriptions
OPS-79   thistle-2  rosa   dn 3 Component list for the status page
OPS-80   thistle-2  omar   rv 4 Custom domain for the status page
OPS-81   thistle-2  elena  td 4 Incident comms training
OPS-73   thistle-3  omar   td 2 Regional failover runbook
OPS-82   thistle-3  elena  bl 3 Postmortem template
OPS-83   thistle-3  -      bl 3 Incident timeline export
OPS-84   thistle-3  -      bl 3 Action item tracking
OPS-85   thistle-3  ben    bl 4 Postmortem review rota
OPS-86   thistle-3  -      bl 3 SSO support runbook
OPS-88   thistle-3  elena  dn 3 Collect postmortem examples
OPS-89   thistle-3  -      bl 4 Refresh the severity definitions
OPS-87   thistle:   -      bl 4 Retire the old status page

# --- Lagoon SSO and SCIM -------------------------------------------------
ENG-180  lagoon-1   iris   dn 1 Parse SAML assertions
ENG-181  lagoon-1   kai    dn 2 Import identity provider metadata
ENG-182  lagoon-1   iris   dn 2 SAML test harness
ENG-183  lagoon-1   theo   dn 2 Just-in-time user creation
ENG-184  lagoon-1   kai    dn 3 SAML error pages
ENG-185  lagoon-1   kai    du 3 SAML sign-in for the mobile app
ENG-186  lagoon-2   iris   ip 1 OIDC connector
ENG-187  lagoon-2   -      td 1 Enforce SSO for a workspace
ENG-188  lagoon-2   chloe  ip 2 SSO setup wizard
ENG-189  lagoon-2   -      bl 3 SSO session lifetime settings
ENG-190  lagoon-2   theo   rv 2 Recovery codes for SSO admins
OPS-90   lagoon-2   rosa   td 3 SSO support macros
ENG-191  lagoon-2   jonas  dn 2 Audit events for SSO sign-ins
ENG-192  lagoon-2   kai    td 2 Test SSO with three identity providers
ENG-193  lagoon-2   -      bl 3 SSO guide for admins
ENG-178  lagoon-2   iris   dn 2 SSO domain verification
ENG-179  lagoon-2   kai    dn 3 SSO button on the sign-in page
ENG-194  lagoon-3   iris   td 1 SCIM users endpoint
ENG-195  lagoon-3   kai    bl 2 SCIM groups endpoint
ENG-196  lagoon-3   -      bl 1 Sync groups to workspace teams
ENG-197  lagoon-3   theo   bl 1 Deprovisioning ends active sessions
ENG-198  lagoon-3   -      bl 3 SCIM settings form
OPS-91   lagoon-3   omar   bl 3 SCIM rate limits at the gateway
OPS-92   lagoon-3   -      bl 4 SCIM support playbook
ENG-199  lagoon-3   kai    bl 2 SCIM conformance tests
ENG-206  lagoon-3   elena  bl 2 Keep directory data in the home region
ENG-177  lagoon-3   kai    dn 2 SCIM token management
ENG-200  lagoon-4   theo   bl 1 Fix the penetration test findings
ENG-201  lagoon-4   -      bl 2 Enterprise admin console
ENG-202  lagoon-4   iris   bl 3 Answer the security questionnaire
OPS-93   lagoon-4   rosa   bl 3 Enterprise onboarding runbook
ENG-203  lagoon-4   -      bl 4 SSO usage analytics
OPS-94   lagoon-4   -      bl 3 Enterprise support tier
ENG-205  lagoon:    -      tr 0 Request: SSO on the free plan

# --- Marble audit log ----------------------------------------------------
ENG-210  marble-1   jonas  dn 1 Audit event schema
ENG-211  marble-1   jonas  dn 2 Audit event storage
ENG-207  marble-1   theo   dn 3 Audit event catalog page
ENG-208  marble-1   ana    dn 3 Retention policy draft
ENG-209  marble-1   chloe  cx 3 Audit events for billing changes
ENG-212  marble-2   jonas  ip 1 Ingest audit events from the event pipeline
ENG-213  marble-2   theo   td 2 Audit log viewer
ENG-214  marble-2   -      bl 3 Filter bar for the audit log
ENG-215  marble-2   jonas  td 1 Audit every permission change
ENG-216  marble-2   -      bl 3 Audit log CSV export
ENG-217  marble-2   dev    dn 3 Audit log performance budget
ENG-218  marble-2   jonas  rv 2 Actor and IP details in audit events
ENG-219  marble-2   -      bl 4 Empty states for the audit log
ENG-228  marble-2   theo   dn 3 Audit log page skeleton
ENG-220  marble-3   -      bl 2 Retention jobs per plan
ENG-221  marble-3   jonas  bl 2 Stream audit logs to customer storage
ENG-222  marble-3   -      bl 3 Legal hold for audit events
ENG-223  marble-3   -      bl 3 Retention settings form
ENG-224  marble-3   theo   bl 3 Sign audit exports
ENG-225  marble-3   jonas  bl 2 Audit custom role changes
ENG-226  marble-3   -      bl 4 Retention FAQ for customers
ENG-229  marble-3   jonas  dn 3 Retention requirements by plan
ENG-227  marble:    -      bl 4 Audit log dark mode

# --- Nettle permissions v2 -----------------------------------------------
ENG-230  nettle-1   theo   dn 1 Role and permission schema
ENG-231  nettle-1   theo   ip 1 Role model service
ENG-232  nettle-1   iris   ip 1 Migrate admin checks to roles
ENG-233  nettle-1   jonas  td 2 Migrate member checks to roles
ENG-234  nettle-1   theo   td 2 Guest role
ENG-235  nettle-1   dev    rv 2 Cache permission checks
ENG-236  nettle-1   iris   td 3 Role model load test
ENG-237  nettle-1   ben    dn 3 Roles API reference
ENG-240  nettle-2   theo   bl 1 Custom roles API
ENG-241  nettle-2   -      bl 2 Role templates
ENG-242  nettle-2   -      bl 2 Custom role editor
ENG-243  nettle-2   iris   bl 2 Permission change events
ENG-244  nettle-2   theo   bl 2 Role change approval flow
ENG-245  nettle-2   -      bl 3 Bulk role assignment
ENG-246  nettle-2   kai    bl 3 Custom roles in the mobile app
ENG-247  nettle-2   -      bl 4 Custom role limits per plan
ENG-238  nettle-2   theo   dn 2 Custom roles design doc
ENG-239  nettle-2   iris   dn 3 Custom roles customer interviews
ENG-248  nettle-3   -      bl 3 Who-can-see-what report
ENG-249  nettle-3   -      bl 4 Export the permission report
ENG-250  nettle-3   theo   bl 3 Suggest unused roles to remove
ENG-251  nettle:    theo   td 3 Review permission error copy

# --- Orchard data warehouse ----------------------------------------------
DATA-1   orchard-1  priya  dn 1 Pick the warehouse engine
DATA-2   orchard-1  marco  dn 2 Hourly product data loads
DATA-3   orchard-1  lena   dn 2 Warehouse access roles
DATA-4   orchard-1  priya  dn 3 Transformation project skeleton
DATA-5   orchard-1  uma    dn 3 Warehouse naming conventions
DATA-6   orchard-1  marco  cx 4 Self-hosted warehouse trial
DATA-7   orchard-2  marco  dn 2 Nightly load orchestration
DATA-8   orchard-2  lena   dn 2 Row-count checks
DATA-9   orchard-2  marco  dn 2 Late-arriving data handling
DATA-10  orchard-2  uma    dn 3 Load status in the data channel
DATA-11  orchard-2  priya  dn 3 Backfill the last two years
DATA-12  orchard-3  priya  ip 1 Semantic layer models for events
DATA-13  orchard-3  lena   td 2 Revenue metric definitions
DATA-14  orchard-3  uma    ip 2 Ranking features table
DATA-15  orchard-3  -      bl 2 Metric ownership registry
DATA-16  orchard-3  lena   rv 2 Workspace activity metrics
DATA-17  orchard-3  -      td 3 Semantic layer docs
DATA-18  orchard-3  priya  dn 2 Semantic layer tool choice
DATA-19  orchard-3  marco  td 3 Metric tests in CI
DATA-27  orchard-3  uma    dn 3 Metric naming review
DATA-28  orchard-3  -      bl 4 Retire the old dashboard metrics
DATA-20  orchard-4  priya  bl 2 Warehouse cost budget per team
DATA-21  orchard-4  -      bl 3 Query cost alerts
DATA-22  orchard-4  -      bl 3 Archive cold tables
DATA-23  orchard-4  marco  bl 3 Cluster keys for the largest tables
DATA-24  orchard-4  -      bl 4 Monthly cost report
DATA-25  orchard-4  uma    bl 4 Auto-suspend idle warehouses
DATA-26  orchard:   -      tr 0 Request: warehouse access for finance

# --- Plume event pipeline ------------------------------------------------
DATA-40  plume-1    marco  dn 1 Event schema v2 spec
DATA-41  plume-1    lena   dn 2 Schema registry
DATA-42  plume-1    marco  dn 2 Event owners for every schema
ENG-255  plume-1    dev    dn 2 SDK support for schema versions
DATA-43  plume-1    uma    dn 3 Schema linting in CI
DATA-44  plume-1    priya  cx 4 Binary encoding evaluation
DATA-45  plume-2    marco  ip 1 Roll out event schema v2
DATA-46  plume-2    -      bl 2 Dead-letter queue for bad events
DATA-47  plume-2    lena   ip 2 Streaming ingestion workers
ENG-256  plume-2    dev    rv 2 Client batching for events
DATA-48  plume-2    -      td 2 Ingestion lag dashboard
ENG-257  plume-2    -      bl 3 Retry budget for event uploads
DATA-49  plume-2    uma    dn 3 Partition events by day
DATA-50  plume-2    marco  td 2 Migrate old producers to schema v2
DATA-51  plume-3    lena   bl 2 Replay any day of events
DATA-52  plume-3    -      bl 2 Exactly-once writes to the warehouse
DATA-53  plume-3    marco  bl 3 Backfill tooling
ENG-258  plume-3    -      bl 3 Event volume quotas per workspace
DATA-54  plume-3    -      bl 4 Replay audit trail
ENG-259  plume-3    dev    td 3 Drop the v1 event endpoint
DATA-56  plume-3    lena   dn 3 Replay design doc
DATA-55  plume:     -      bl 4 Event naming lint rules

# --- Quarry reports (planned) --------------------------------------------
DATA-70  quarry-1   lena   td 1 Report builder data source
DATA-71  quarry-1   -      bl 2 Chart picker
GRO-1    quarry-1   quinn  td 2 Report builder onboarding tour
DATA-72  quarry-1   uma    bl 2 Saved report permissions
GRO-2    quarry-1   -      bl 3 Recruit design partners
DATA-73  quarry-1   lena   bl 3 Report filters panel
GRO-3    quarry-1   nadia  dn 3 Report builder pricing research
DATA-81  quarry-1   lena   dn 2 Report builder prototype
GRO-7    quarry-1   quinn  dn 3 Design partner shortlist
DATA-74  quarry-2   -      bl 2 Report scheduler
DATA-75  quarry-2   lena   bl 2 Scheduled report delivery
GRO-4    quarry-2   quinn  bl 3 Report email templates
DATA-76  quarry-2   -      bl 3 Schedule settings form
GRO-5    quarry-2   -      bl 4 Scheduled report usage tracking
DATA-77  quarry-2   uma    bl 3 Report delivery retries
GRO-8    quarry-2   quinn  dn 3 Scheduled report research
DATA-82  quarry-2   -      bl 4 Report delivery logs
DATA-78  quarry-3   -      bl 3 Embeddable dashboard frame
DATA-79  quarry-3   -      bl 4 Signed embed tokens
GRO-6    quarry-3   nadia  bl 4 Embedded dashboards pricing
DATA-80  quarry-3   lena   bl 4 Embed theming

# --- Saffron pricing -----------------------------------------------------
GRO-20   saffron-1  nadia  dn 1 Plan catalog service
GRO-21   saffron-1  quinn  dn 2 Pricing page from the catalog
ENG-265  saffron-1  chloe  dn 2 Entitlement checks read the catalog
GRO-22   saffron-1  nadia  dn 3 Add-on definitions
GRO-23   saffron-1  uma    cx 4 Legacy plan mapping
GRO-24   saffron-2  nadia  ip 1 Usage metering from product events
ENG-266  saffron-2  chloe  rv 2 Seat counting service
GRO-25   saffron-2  quinn  dn 2 Usage on the billing page
ENG-267  saffron-2  dev    dn 2 Invoice line items for usage
GRO-26   saffron-2  uma    dn 3 Usage alerts for admins
GRO-27   saffron-2  nadia  td 3 Overage pricing copy
ENG-268  saffron-2  chloe  dn 2 Proration for seat changes
GRO-28   saffron-2  quinn  dn 4 Billing FAQ update
GRO-31   saffron-3  nadia  bl 1 Enterprise plan entitlements
GRO-32   saffron-3  -      bl 2 Enterprise price book
GRO-33   saffron-3  -      bl 1 Enterprise plan checkout
GRO-34   saffron-3  quinn  bl 3 Plan picker form
ENG-269  saffron-3  chloe  bl 2 Annual contracts in billing
GRO-35   saffron-3  -      bl 3 Enterprise trial flow
GRO-36   saffron-3  uma    bl 4 Enterprise plan comparison table
ENG-270  saffron-3  -      bl 3 Purchase orders and invoices
GRO-37   saffron-3  nadia  dn 2 Enterprise pricing research
GRO-40   saffron-4  nadia  bl 1 Enterprise launch go/no-go
GRO-41   saffron-4  quinn  bl 2 Enterprise launch announcement
GRO-42   saffron-4  -      bl 3 Sales enablement deck
GRO-43   saffron-4  -      bl 3 Enterprise case study
ENG-271  saffron-4  -      bl 3 Launch-day load plan
GRO-44   saffron-4  rosa   bl 4 Partner launch briefing
GRO-45   saffron-4  chloe  bl 3 Enterprise landing page
GRO-46   saffron-4  -      bl 4 Launch FAQ
GRO-29   saffron:   -      tr 0 Request: nonprofit discount

# --- Umber lifecycle email -----------------------------------------------
GRO-50   umber-1    quinn  ip 1 Trigger emails from product events
GRO-51   umber-1    -      td 2 Trial ending email
GRO-52   umber-1    chloe  td 2 Inactive workspace nudge
GRO-53   umber-1    quinn  dn 2 Email template system
GRO-54   umber-1    -      bl 3 Email frequency cap
GRO-55   umber-1    rosa   rv 3 Email footer and unsubscribe
GRO-57   umber-1    uma    dn 3 Lifecycle email metrics
GRO-56   umber-2    -      bl 2 Enterprise welcome email series
GRO-58   umber-2    quinn  bl 3 Admin setup reminder emails
GRO-59   umber-2    -      bl 3 SSO setup nudge
GRO-60   umber-2    -      bl 4 Seat expansion suggestions
GRO-61   umber-2    uma    bl 4 Onboarding email A/B test
GRO-63   umber-2    quinn  dn 3 Enterprise welcome copy draft
GRO-62   umber:     -      bl 4 Email preview tool

# --- Willow help center (no initiative) ----------------------------------
OPS-100  willow-1   rosa   ip 2 Move help articles to the new help center
OPS-101  willow-1   -      bl 2 Redirects from the old help site
GRO-70   willow-1   quinn  td 3 Help center search
OPS-102  willow-1   rosa   dn 3 Help center theme
OPS-103  willow-1   -      td 3 Article feedback widget
GRO-71   willow-1   -      bl 4 Help center analytics
OPS-104  willow-1   elena  td 2 Help center SSO for agents
OPS-105  willow-2   -      bl 3 Contextual help links in settings
OPS-106  willow-2   rosa   bl 2 Enterprise section in the help center
GRO-72   willow-2   -      bl 3 In-app help panel
OPS-107  willow-2   -      bl 3 Contact support form
GRO-73   willow-2   quinn  bl 4 Help panel usage tracking
OPS-108  willow-2   elena  bl 4 Help article review cadence
GRO-74   willow-2   quinn  dn 4 Help panel design
OPS-110  willow-2   -      bl 4 Help article ownership
OPS-109  willow:    -      bl 4 Help center style guide

# --- Sorrel partners (Backlog) -------------------------------------------
GRO-80   sorrel-1   nadia  bl 2 Partner API requirements
ENG-280  sorrel-1   -      bl 2 Partner OAuth apps
ENG-281  sorrel-1   -      bl 3 Partner API rate limits
GRO-81   sorrel-1   -      bl 3 Partner program terms
ENG-282  sorrel-1   jonas  bl 3 Partner sandbox workspaces
GRO-82   sorrel-2   -      bl 3 Marketplace listing pages
GRO-83   sorrel-2   -      bl 4 Listing review process
ENG-283  sorrel-2   -      bl 4 Install flow for marketplace apps
GRO-84   sorrel-3   -      bl 4 Revenue share payouts
GRO-85   sorrel-3   -      bl 4 Partner payout reports

# --- No project (open only) ----------------------------------------------
ENG-290  -          kai    td 2 Upgrade the mobile build toolchain
ENG-291  -          -      tr 0 Flaky checkout test in CI
ENG-292  -          chloe  ip 2 Rotate the staging database credentials
OPS-120  -          omar   td 3 Laptop refresh for new hires
OPS-121  -          -      tr 0 Badge reader at the second office
DATA-90  -          priya  td 3 Quarterly data access review
GRO-95   -          nadia  ip 3 Customer advisory board agenda
GRO-96   -          -      tr 0 Webinar recording edits
`;

// Blocking relations: `A > B > C` means A blocks B and B blocks C. Every
// relation flows forward in time and in the project order below, except
// the three designed cycles (see showcase.ts SHOWCASE_CYCLES):
//   plume, orchard, atlas, beacon, juniper, harbor, ridge, thistle, delta,
//   fjord, quarry, lagoon, nettle, marble, saffron, ember, umber, compass,
//   sorrel, garnet, willow
// and initiatives flow Platform / Insights -> Enterprise -> Growth -> none
// (Insights receives from nobody; Enterprise sends only to "none"), so the
// only initiative-level cycle is the base workspace's own Platform <->
// Growth (ENG-12 > ENG-23 > OPS-20).
export const RELATION_TABLE = `
# The critical path: the enterprise launch, 13 issues across 6 projects.
ENG-60 > ENG-186 > ENG-187 > ENG-194 > ENG-196 > ENG-240 > ENG-242 > ENG-225 > GRO-31 > GRO-33 > GRO-40 > GRO-41 > OPS-106

# Side work feeding the critical path, and what it unlocks.
OPS-91 > ENG-194
ENG-195 > ENG-196
ENG-231 > ENG-240
ENG-232 > ENG-240
ENG-241 > ENG-242
ENG-247 > GRO-31
GRO-32 > GRO-33
ENG-269 > GRO-33
GRO-45 > GRO-41
GRO-31 > GRO-35
ENG-242 > ENG-246
GRO-40 > GRO-42
GRO-40 > GRO-43

# Fan-in: the go/no-go waits on every enterprise workstream.
ENG-197 > GRO-40
ENG-202 > GRO-40
OPS-93 > GRO-40
OPS-94 > GRO-40
ENG-220 > GRO-40
OPS-60 > GRO-40
OPS-86 > GRO-40
ENG-271 > GRO-40

# Fan-out: the overdue event schema rollout holds up four projects.
DATA-45 > DATA-47 > DATA-48
DATA-45 > DATA-50
DATA-45 > DATA-51
DATA-45 > DATA-12
DATA-45 > DATA-70
DATA-45 > ENG-212
DATA-45 > GRO-24
DATA-45 > GRO-50
DATA-45 > ENG-120

# Fan-out: the unassigned, overdue capacity plan holds up the failover work.
OPS-52 > OPS-53
OPS-52 > OPS-56 > OPS-57
OPS-52 > OPS-59
OPS-52 > OPS-73
OPS-52 > ENG-206

# Fan-out: form components (base ENG-73) gate every new form.
ENG-71 > ENG-72 > ENG-73
ENG-73 > ENG-123
ENG-73 > ENG-152
ENG-73 > ENG-223
ENG-73 > GRO-34
ENG-73 > OPS-107

# Cycles: permission events and audit wait on each other (nettle/marble),
# and the failover drill and its runbook do (ridge/thistle, Operations).
ENG-243 > ENG-215 > ENG-244 > ENG-243
OPS-55 > OPS-73 > OPS-55

# Atlas: the shutdown waits on the read path switch.
ENG-16 > ENG-100 > ENG-102 > ENG-103
ENG-101 > ENG-103

# Beacon: alpha history, then personalization on the ranking features.
ENG-86 > ENG-87
ENG-86 > ENG-20
ENG-88 > ENG-22
ENG-28 > ENG-112
DATA-14 > ENG-110 > ENG-111 > ENG-112

# Compass, Delta, Ember, Garnet: local chains.
ENG-31 > ENG-32
OPS-5 > OPS-40 > OPS-41
OPS-40 > OPS-44
OPS-43 > OPS-41
ENG-41 > ENG-120 > ENG-121 > ENG-124
ENG-120 > ENG-122
ENG-92 > ENG-94 > ENG-50 > ENG-51
ENG-93 > ENG-94
ENG-130 > ENG-132 > ENG-133
ENG-130 > ENG-134

# Harbor: the frozen design, then the SDKs from the v3 spec.
ENG-81 > ENG-82
ENG-81 > ENG-83
ENG-62 > ENG-140 > ENG-141 > ENG-143
ENG-140 > ENG-142 > ENG-143
ENG-63 > ENG-144
ENG-146 > ENG-144

# Juniper: the audit fed the tokens; the docs site.
ENG-96 > ENG-98 > ENG-70
ENG-150 > ENG-151

# Ridge: routing, residency, drills, GA.
ENG-160 > ENG-161 > ENG-162 > ENG-164 > ENG-167 > ENG-172 > OPS-60
OPS-50 > OPS-51 > OPS-53
ENG-164 > ENG-165 > ENG-166
ENG-164 > ENG-170 > OPS-57
ENG-169 > OPS-57
OPS-55 > OPS-57 > OPS-58 > ENG-172
ENG-173 > OPS-60
OPS-59 > OPS-60

# Thistle: paging, the stalled status page, postmortems.
OPS-72 > OPS-70 > OPS-71 > OPS-81
OPS-79 > OPS-76 > OPS-77
OPS-76 > OPS-78
OPS-83 > OPS-82 > OPS-84

# Lagoon: SAML history, SSO GA, SCIM, hardening.
ENG-180 > ENG-183
ENG-182 > ENG-184
ENG-188 > ENG-193
ENG-178 > ENG-192
ENG-186 > ENG-192
ENG-187 > ENG-189
ENG-191 > ENG-212
ENG-194 > ENG-197
ENG-194 > ENG-199
ENG-200 > ENG-202

# Marble: schema history, the viewer, retention.
ENG-210 > ENG-211 > ENG-212 > ENG-213 > ENG-214
ENG-210 > ENG-207
ENG-213 > ENG-216 > ENG-221 > ENG-224
ENG-218 > ENG-213
ENG-220 > ENG-222

# Nettle: the role model, custom roles, insights.
ENG-230 > ENG-231 > ENG-232
ENG-231 > ENG-233
ENG-231 > ENG-243
ENG-235 > ENG-236
ENG-248 > ENG-249

# Orchard: foundations, loads, the semantic layer, costs.
DATA-1 > DATA-2 > DATA-7 > DATA-8 > DATA-12
DATA-1 > DATA-4
DATA-7 > DATA-9
DATA-18 > DATA-12 > DATA-13
DATA-12 > DATA-16
DATA-12 > DATA-70
DATA-20 > DATA-21 > DATA-24
DATA-21 > DATA-75

# Plume: schema v2 history, ingestion, replay.
DATA-40 > DATA-41 > DATA-43
DATA-40 > ENG-255 > ENG-256
DATA-41 > DATA-45
DATA-46 > DATA-47
DATA-52 > DATA-51 > DATA-53 > DATA-75

# Quarry: the builder, then scheduled delivery (fan-in).
DATA-70 > DATA-71
DATA-70 > DATA-73
DATA-72 > DATA-75
DATA-74 > DATA-75
GRO-4 > DATA-75 > DATA-77
DATA-78 > DATA-79

# Saffron: the catalog, usage billing, the enterprise plan.
GRO-20 > GRO-21
GRO-20 > ENG-265 > ENG-266
GRO-24 > GRO-27
ENG-269 > ENG-270

# More dependencies between linked work (denser chains, no new boxes).
ENG-35 > ENG-125
OPS-46 > ENG-36
ENG-192 > ENG-193
ENG-199 > ENG-197
ENG-167 > ENG-206
OPS-53 > OPS-56 > OPS-59
OPS-57 > OPS-59
ENG-173 > ENG-172
DATA-47 > DATA-51
DATA-50 > GRO-24
DATA-50 > ENG-212
DATA-12 > DATA-14
DATA-13 > DATA-70
DATA-16 > DATA-73
ENG-221 > ENG-222
ENG-224 > GRO-40
ENG-233 > ENG-240
ENG-236 > ENG-240
GRO-27 > GRO-33
GRO-24 > GRO-31
GRO-51 > GRO-52
OPS-101 > OPS-103
OPS-77 > OPS-78
OPS-82 > OPS-73
OPS-83 > OPS-84
ENG-100 > ENG-101
ENG-121 > ENG-122
ENG-123 > ENG-124
ENG-141 > ENG-144
ENG-132 > ENG-134
ENG-70 > ENG-72
GRO-1 > DATA-71
DATA-74 > DATA-77
ENG-189 > ENG-193
OPS-58 > OPS-59
ENG-170 > ENG-172
DATA-48 > DATA-53
DATA-46 > DATA-52
DATA-70 > DATA-72
DATA-71 > DATA-74
OPS-40 > OPS-43
ENG-197 > ENG-200
ENG-232 > ENG-233

# Umber, Willow, Sorrel.
GRO-50 > GRO-51
GRO-50 > GRO-52
GRO-58 > GRO-59
OPS-100 > OPS-101
OPS-100 > OPS-103
OPS-105 > GRO-72 > GRO-73
GRO-80 > ENG-280 > ENG-282
GRO-81 > GRO-84
GRO-82 > GRO-83
`;

/** Labels the new teams use (the base workspace's labels stay). */
export const SHOWCASE_LABELS: readonly FixtureLabel[] = [
  {
    id: 'lbl-data-pipeline',
    name: 'Pipeline',
    color: '#26b5ce',
    teamId: 'team-data',
    parentId: null,
    isGroup: false,
    groupType: null,
    archived: false,
  },
  {
    id: 'lbl-data-modeling',
    name: 'Modeling',
    color: '#5e6ad2',
    teamId: 'team-data',
    parentId: null,
    isGroup: false,
    groupType: null,
    archived: false,
  },
  {
    id: 'lbl-gro-experiment',
    name: 'Experiment',
    color: '#f2c94c',
    teamId: 'team-gro',
    parentId: null,
    isGroup: false,
    groupType: null,
    archived: false,
  },
  {
    id: 'lbl-gro-lifecycle',
    name: 'Lifecycle',
    color: '#4cb782',
    teamId: 'team-gro',
    parentId: null,
    isGroup: false,
    groupType: null,
    archived: false,
  },
];

/** Estimate scales of the new teams (Data: linear; Growth: T-shirt). */
export const SHOWCASE_ESTIMATE_SCALES: Readonly<Record<string, EstimateScale>> =
  {
    'team-data': { type: 'linear', allowZero: false, extended: false },
    'team-gro': { type: 'tShirt', allowZero: false, extended: false },
  };

/** Descriptions of the issues the showcase's story runs through. */
export const SHOWCASE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'ENG-186':
    'OpenID Connect next to SAML, so admins can use any modern identity provider.\n\n- Discovery from the issuer URL\n- Claims mapped onto workspace roles\n- Works with the v3 auth endpoints (ENG-60)',
  'ENG-187':
    'An admin can require SSO for every member. Password sign-in is turned off for the workspace, and existing sessions are asked to re-authenticate.\n\nNobody owns this yet, and the SCIM work waits on it.',
  'ENG-194':
    'SCIM 2.0 `/Users`: create, update, deactivate. Provisioning assumes SSO is enforced (ENG-187).',
  'ENG-196':
    'Map identity provider groups onto workspace teams so access follows the directory. Custom roles (ENG-240) build on this.',
  'ENG-240':
    'Create, update and delete custom roles through the API, and assign them to synced groups.',
  'GRO-31':
    'Enterprise plan entitlements in the plan catalog: SSO enforcement, SCIM, custom roles, audit log retention.',
  'GRO-40':
    'The launch review. Every enterprise workstream has to be green: SCIM, custom roles, audit retention, the second region, support runbooks, the penetration test and the checkout.',
  'DATA-45':
    'Switch every producer to the v2 event schema. Late: two producers still send v1 payloads, and the audit log, usage billing, lifecycle email, the inbox and the semantic layer all wait on it.',
  'OPS-52':
    'How much capacity the second region needs for the EU workspaces and for failover. Nobody has picked this up, and the failover drills and directory residency wait on it.',
  'ENG-215':
    'Every role grant and revocation becomes an audit event. Waits on the permission change events (ENG-243), which in turn wait on the approval flow that needs these audit events: a cycle to break.',
  'OPS-55':
    'Plan the first production failover drill. The plan needs the regional failover runbook (OPS-73), and the runbook needs the drill plan: one of them has to go first.',
  'OPS-76':
    'A public status page with components for the app, the API and the second region.',
  'GRO-24':
    'Meter seats and usage from product events (v2 schema) and send them to billing.',
};

/** A seeded comment in the showcase (ids continue after the base's). */
export interface ShowcaseCommentSpec {
  issue: string;
  authorId: string;
  daysAgo: number;
  hour: number;
  body: string;
  /** Index in SHOWCASE_COMMENTS of the comment this one replies to. */
  replyTo?: number;
}

export const SHOWCASE_COMMENTS: readonly ShowcaseCommentSpec[] = [
  {
    issue: 'ENG-187',
    authorId: 'user-iris',
    daysAgo: 4,
    hour: 10,
    body: 'This is the next step on the enterprise launch path and still has no owner. SCIM, custom roles and the checkout all queue behind it.',
  },
  {
    issue: 'ENG-187',
    authorId: 'user-theo',
    daysAgo: 3,
    hour: 15,
    body: 'I can take it once the role model service is in review, so early next week at best.',
    replyTo: 0,
  },
  {
    issue: 'DATA-45',
    authorId: 'user-marco',
    daysAgo: 2,
    hour: 9,
    body: 'Two producers left on v1: the mobile app and the billing webhooks. Both have a fix in review.',
  },
  {
    issue: 'DATA-45',
    authorId: 'user-nadia',
    daysAgo: 1,
    hour: 11,
    body: 'Usage metering for billing needs v2 before the usage-based billing milestone. Can we land billing webhooks first?',
    replyTo: 2,
  },
  {
    issue: 'OPS-52',
    authorId: 'user-elena',
    daysAgo: 5,
    hour: 14,
    body: 'The EU migration is ready to go but we cannot size the second region without this plan. Looking for an owner in Operations.',
  },
  {
    issue: 'ENG-215',
    authorId: 'user-jonas',
    daysAgo: 6,
    hour: 16,
    body: 'Proposal to break the cycle: emit the permission change events without the approval step first, then add approvals on top.',
  },
  {
    issue: 'OPS-55',
    authorId: 'user-omar',
    daysAgo: 3,
    hour: 10,
    body: 'Drafting the drill plan against the old runbook for now; we will update both after the first drill.',
  },
  {
    issue: 'GRO-40',
    authorId: 'user-nadia',
    daysAgo: 2,
    hour: 13,
    body: 'Go/no-go is booked. Nine workstreams feed into it; the path through SSO, SCIM and custom roles is the long pole.',
  },
  {
    issue: 'OPS-76',
    authorId: 'user-rosa',
    daysAgo: 10,
    hour: 9,
    body: 'Blocked on the status page vendor contract; nothing moved since the component list was done.',
  },
];
