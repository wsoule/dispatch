// Public API of @dispatch/ui. Every component takes plain props (see
// ./types.ts) and renders links through the host-injected component (see
// ./lib/link.tsx), so the package carries no framework or domain coupling.
// Import '@dispatch/ui/styles.css' once, globally, in the host.
export * from './types';
export { Link, UiLinkProvider, type UiLinkProviderProps } from './lib/link';
export { themeScript } from './lib/theme';
export {
  default as BlockBar,
  type BlockBarProps,
} from './components/block-bar';
export {
  AVATAR_HUES,
  type AvatarHue,
  avatarHue,
  InitialsAvatar,
  type InitialsAvatarProps,
} from './components/initials-avatar';
export {
  default as StatusMark,
  type StatusMarkProps,
} from './components/status-mark';
export {
  default as Tabs,
  type TabItem,
  type TabsProps,
} from './components/tabs';
export {
  default as ThemeToggle,
  type ThemeToggleProps,
} from './components/theme-toggle';

// ---- tasks family (src/tasks): primitives, the grouped task table,
// deadlines, stats strip and registers. Props are typed in ./tasks/types.
export { Button } from './tasks/button';
export { Checkbox } from './tasks/checkbox';
export { Checklist } from './tasks/checklist';
export { Chip } from './tasks/chip';
export {
  parseCollapsed,
  serializeCollapsed,
  toggleCollapsed,
} from './tasks/collapsed-groups';
export { DeadlineList } from './tasks/deadline-list';
export { NavTabs } from './tasks/nav-tabs';
export { EmptyState, Notice } from './tasks/notice';
export { ProgressRule } from './tasks/progress-rule';
export { Register, RegisterCell, RegisterRow } from './tasks/register';
export { SegmentedControl } from './tasks/segmented-control';
export { StatsStrip } from './tasks/stats-strip';
export { Switch } from './tasks/switch';
export { PriorityGlyph, StateGlyph } from './tasks/task-glyphs';
export { TaskGroupTable } from './tasks/task-group-table';
export {
  pruneSelection,
  rangeIds,
  setIds,
  toggleId,
} from './tasks/task-selection';
export { BulkBar } from './tasks/bulk-bar';
export { useBulkBarHeight } from './tasks/bulk-bar-height';
export { FilterChips } from './tasks/filter-chips';
export { ToolbarBadge, ViewToolbar } from './tasks/view-toolbar';
export type {
  BulkBarConfirm,
  BulkBarProps,
  ButtonAsButtonProps,
  ButtonAsLinkProps,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  CheckboxProps,
  ChecklistItem,
  ChecklistProps,
  ChipProps,
  ChipTone,
  DeadlineGroup,
  DeadlineItem,
  DeadlineListProps,
  EmptyStateProps,
  FilterChipData,
  FilterChipsProps,
  NavTabItem,
  NavTabsProps,
  NoticeProps,
  ProgressRuleProps,
  RegisterCellProps,
  RegisterButtonRowProps,
  RegisterColumn,
  RegisterLinkRowProps,
  RegisterPlainRowProps,
  RegisterProps,
  RegisterRowProps,
  SegmentedControlProps,
  SegmentedOption,
  StatCell,
  StatsStripProps,
  SwitchProps,
  TaskChipData,
  TaskColumnId,
  TaskDragProps,
  TaskGroupData,
  TaskGroupProgress,
  TaskGroupTableProps,
  TaskPriority,
  TaskRowData,
  TaskSectionData,
  TaskSelectionProps,
  TaskStateKind,
  ViewToolbarProps,
  ViewToolbarSearch,
} from './tasks/types';

// ---- shell family (src/shell): the app frame and overlays (architecture
// §8.3) — AppShell, SignedOutFrame, command palette + shortcuts, toasts,
// slide-over, property list, alert strip, skeletons, key caps. Props are
// typed in ./shell/types.
export { default as AlertStrip } from './shell/alert-strip';
export { default as AppShell, toggleShellCollapsed } from './shell/app-shell';
export {
  CommandPalette,
  CommandPaletteProvider,
  shortcutCode,
  ShortcutSheet,
  useCommandPalette,
  useOptionalCommandPalette,
} from './shell/command-palette';
export { type FuzzyMatch, fuzzyMatch, highlightRuns } from './shell/fuzzy';
export { useModKeyLabel } from './shell/dom';
export { Kbd, KbdKeys } from './shell/kbd';
export { isSignOutForm } from './shell/types';
export { default as PropertyList } from './shell/property-list';
export { sidebarCollapseScript } from './shell/sidebar-script';
export { default as SignedOutFrame } from './shell/signed-out-frame';
export {
  Skeleton,
  SkeletonBlock,
  SkeletonRows,
  SkeletonText,
} from './shell/skeleton';
export { default as SlideOver, SLIDE_OVER_WIDTH } from './shell/slide-over';
export { ToastProvider, useToast } from './shell/toast';
export type {
  AlertStripAction,
  AlertStripProps,
  AppShellProps,
  CommandPaletteApi,
  CommandPaletteProps,
  CommandPaletteProviderProps,
  KbdKeysProps,
  KbdProps,
  PaletteItem,
  PaletteView,
  PropertyListItem,
  PropertyListProps,
  ShellCrumb,
  ShellIcon,
  ShellIconProps,
  ShellNavItem,
  ShellSection,
  ShellSectionItem,
  ShellSettingsLink,
  ShellSignOut,
  ShellSignOutAction,
  ShellSignOutForm,
  ShellTab,
  ShellUser,
  ShortcutGroup,
  ShortcutRow,
  ShortcutSheetProps,
  SignedOutFrameProps,
  SkeletonBlockProps,
  SkeletonProps,
  SkeletonRowsProps,
  SkeletonTextProps,
  SlideOverProps,
  ToastApi,
  ToastInput,
  ToastKind,
  ToastProviderProps,
} from './shell/types';

// ---- timeline family (src/timeline): the Gr8r Gantt in the Matrix
// drawing style (architecture §8.4 Timeline) — TimelineChart plus the pure
// date↔x helpers it is built on. Props are typed in ./timeline/types.
export {
  addDays,
  centerXForDate,
  createScale,
  dateForX,
  dayIndex,
  daysBetween,
  dayTicks,
  formatDay,
  formatDayLong,
  isoForDayIndex,
  monthSpans,
  snapDays,
  type TimeScale,
  weekendSpans,
  weekTicks,
  xForDate,
} from './timeline/dates';
export { TimelineChart } from './timeline/timeline-chart';
export type {
  TimelineBar,
  TimelineChartProps,
  TimelineDependency,
  TimelineGroup,
  TimelineGroupLink,
  TimelineLane,
  TimelineLegendItem,
  TimelineUndated,
  TimelineZoom,
} from './timeline/types';

// ---- graph family (src/graph): the dependency graph (architecture §8.4
// Graph, §2.10) — the pure dagre layout (flat, or in labelled clusters
// with packed grids and shelves, ./graph/pack), the upstream/downstream chain
// helpers and path walks (both paths, "Ready next", the critical path and
// the readout copy), the pan/zoom DependencyGraph, its legend and the Copy
// Mermaid block. Props are typed in ./graph/types.
export {
  blockerIndex,
  downstreamChain,
  upstreamChain,
  waiterIndex,
} from './graph/chain';
export type {
  BlockerIndex,
  BlockerIndexOptions,
  DownstreamChain,
} from './graph/chain';
export {
  chainPhrase,
  defaultGraphPathWords,
  describePaths,
  longestChain,
  longestChains,
  nameList,
  nodePaths,
  PATH_GROUP_CAP,
  PATH_NAME_BUDGET,
  PATH_NAME_CAP,
  pathContext,
  pathNameCounts,
  pathNamePhrase,
  pathNodeName,
  readoutText,
  resolvePathWords,
  sccGroups,
} from './graph/paths';
export type {
  ChainEdge,
  LongestChains,
  NodePaths,
  OpenChain,
  PathContext,
  PathNameCounts,
  PathNode,
  PathReadout,
} from './graph/paths';
export { DependencyGraph } from './graph/dependency-graph';
export { defaultGraphLegend, GraphLegend } from './graph/graph-legend';
export {
  CLUSTER_METRICS,
  edgeKey,
  GRAPH_METRICS,
  layoutGraph,
  measureNode,
  type NodeMeasure,
} from './graph/layout';
export {
  gridColumns,
  packGrid,
  packShelves,
  type Packed,
  type PackSize,
  shelfWidth,
} from './graph/pack';
export { COPIED_MS, MermaidSource } from './graph/mermaid-source';
export type {
  DependencyGraphProps,
  GraphClusterData,
  GraphDirection,
  GraphEdgeData,
  GraphEdgeKind,
  GraphHighlight,
  GraphLayout,
  GraphLayoutOptions,
  GraphLegendItem,
  GraphLegendMark,
  GraphLegendProps,
  GraphNodeData,
  GraphNodeReadiness,
  GraphNodeTag,
  GraphNodeTone,
  GraphPathWords,
  GraphReadinessState,
  LaidOutEdge,
  LaidOutGroup,
  LaidOutNode,
  MermaidSourceProps,
  UpstreamChain,
} from './graph/types';

// ---- task family (src/task): the detail view of one task (issue) — the
// TaskDetail sheet (drawer or page layout), TaskSlideOver around it, and
// the parts a host can reuse on their own: description, relation list,
// activity ledger, section heading and property value. Read-only or
// editable is the host's call (values are nodes). Props are typed in
// ./task/types.
export { TaskCrumbs } from './task/task-crumbs';
export { TaskActivityList } from './task/task-activity-list';
export { TaskCommentList } from './task/task-comment-list';
export { TaskDescription } from './task/task-description';
export { TaskDetail } from './task/task-detail';
export { TaskPropertyValue } from './task/task-property-value';
export { TaskRelationList } from './task/task-relation-list';
export { TaskDetailSection } from './task/task-section';
export { TaskSlideOver } from './task/task-slide-over';
export { DEFAULT_TASK_LABELS } from './task/shared';
export type {
  TaskActivityItem,
  TaskActivityListProps,
  TaskComment,
  TaskCommentListProps,
  TaskCommentsData,
  TaskCrumbsProps,
  TaskDescriptionData,
  TaskDescriptionProps,
  TaskDetailAlert,
  TaskDetailLabels,
  TaskDetailLayout,
  TaskDetailProps,
  TaskDetailSectionMeta,
  TaskDetailSectionProps,
  TaskDetailStatus,
  TaskPropertyValueProps,
  TaskRelation,
  TaskRelationListProps,
  TaskRelations,
  TaskSlideOverProps,
} from './task/types';

// ---- edit family (src/edit): the controls an editable host puts into the
// task view — PickerPopover and its property presets, the relation search,
// the in-place title field, the description/comment editor and the date
// field. Every control is controlled and saves through one contract: the
// callback returns a promise; pending, then kept, or rolled back with the
// error printed beside it. Props are typed in ./edit/types.
export { DateField, isCompleteDate } from './edit/date-field';
export { InlineTextField } from './edit/inline-text-field';
export { PickerMarkView, type PickerMarkViewProps } from './edit/picker-mark';
export { PickerPopover } from './edit/picker-popover';
export {
  type Placement,
  type PlacementInput,
  placePopover,
} from './edit/position';
export {
  AssigneePicker,
  EstimatePicker,
  LabelPicker,
  MilestonePicker,
  PRIORITY_LABELS,
  PriorityPicker,
  ProjectPicker,
  StatePicker,
} from './edit/property-pickers';
export {
  saveErrorMessage,
  type SaveControl,
  useSaveControl,
  valueKey,
} from './edit/save-state';
export {
  DEFAULT_EDIT_LABELS,
  filterOptions,
  groupOptions,
  initials,
  isHexColor,
  type OptionGroup,
} from './edit/shared';
export { TaskRelationPicker } from './edit/task-relation-picker';
export { TextAreaEditor } from './edit/text-area-editor';
export type {
  AssigneePickerProps,
  DateFieldProps,
  EditLabels,
  ErrorFormatter,
  EstimateChoice,
  EstimatePickerProps,
  InlineTextFieldProps,
  LabelChoice,
  LabelPickerProps,
  MilestonePickerProps,
  MultiPickerProps,
  PersonChoice,
  PickerAppearance,
  PickerMark,
  PickerOption,
  PickerPopoverProps,
  PickerPresetBaseProps,
  PlanChoice,
  PriorityPickerProps,
  ProjectPickerProps,
  SaveResult,
  SinglePickerProps,
  StateChoice,
  StatePickerProps,
  TaskRelationPickerProps,
  TaskSearchResult,
  TextAreaEditorProps,
} from './edit/types';
