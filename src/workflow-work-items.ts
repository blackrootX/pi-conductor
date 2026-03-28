import { createHash } from "node:crypto";
import type {
  BlockedWorkSummaryItem,
  NewWorkItemInput,
  ResolvedWorkItemInput,
  WorkItem,
} from "./workflow-types.js";

const RECENT_RESOLVED_DEFAULT_LIMIT = 5;

export interface WorkItemProjection {
  readyWorkItems: WorkItem[];
  blockedWorkSummary: BlockedWorkSummaryItem[];
  unresolvedWorkItems: WorkItem[];
  currentFocus?: string;
}

export type WorkItemMutationResult =
  | {
      ok: true;
      workItems: WorkItem[];
      projection: WorkItemProjection;
    }
  | {
      ok: false;
      diagnostics: string[];
    };

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeWorkItemTitle(title: string): string {
  return normalizeWhitespace(title)
    .toLowerCase()
    .replace(/[`"'()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function createWorkItemId(title: string): string {
  const normalizedTitle =
    normalizeWorkItemTitle(title) ||
    normalizeWhitespace(title).toLowerCase() ||
    "work-item";
  const digest = createHash("sha1")
    .update(normalizedTitle)
    .digest("hex")
    .slice(0, 12);
  return `work-${digest}`;
}

function compareByUpdatedAtDesc(left: WorkItem, right: WorkItem): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function compareByPriority(left: WorkItem, right: WorkItem): number {
  const rank = { high: 0, medium: 1, low: 2, undefined: 3 } as const;
  const leftRank = rank[left.priority ?? "undefined"];
  const rightRank = rank[right.priority ?? "undefined"];
  if (leftRank !== rightRank) return leftRank - rightRank;
  return compareByUpdatedAtDesc(left, right);
}

function compareReady(left: WorkItem, right: WorkItem): number {
  const statusRank = {
    in_progress: 0,
    open: 1,
    blocked: 2,
    done: 3,
  } as const;
  const leftRank = statusRank[left.status];
  const rightRank = statusRank[right.status];
  if (leftRank !== rightRank) return leftRank - rightRank;
  return compareByPriority(left, right);
}

function normalizeOptionalTitles(titles: string[] | undefined): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const title of titles ?? []) {
    const trimmed = normalizeWhitespace(title);
    if (!trimmed) continue;
    const key = normalizeWorkItemTitle(trimmed) || trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function mergePriority(
  current: WorkItem["priority"],
  incoming: WorkItem["priority"],
): WorkItem["priority"] {
  if (!current) return incoming;
  if (!incoming) return current;
  const rank = { high: 3, medium: 2, low: 1 } as const;
  return rank[incoming] > rank[current] ? incoming : current;
}

function cloneWorkItem(item: WorkItem): WorkItem {
  return {
    ...item,
    blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
  };
}

function pushUniqueDiagnostic(
  diagnostics: string[],
  message: string,
): void {
  const trimmed = message.trim();
  if (!trimmed || diagnostics.includes(trimmed)) return;
  diagnostics.push(trimmed);
}

function buildTitleIndex(workItems: WorkItem[]): Map<string, WorkItem> {
  const titleIndex = new Map<string, WorkItem>();
  for (const item of workItems) {
    const normalizedTitle = normalizeWorkItemTitle(item.title);
    if (!normalizedTitle) continue;
    titleIndex.set(normalizedTitle, item);
  }
  return titleIndex;
}

function validateCanonicalTitleUniqueness(workItems: WorkItem[]): string[] {
  const diagnostics: string[] = [];
  const titleOwners = new Map<string, string>();
  for (const item of workItems) {
    const normalizedTitle = normalizeWorkItemTitle(item.title);
    if (!normalizedTitle) {
      pushUniqueDiagnostic(
        diagnostics,
        `Work item "${item.id}" is missing a usable normalized title.`,
      );
      continue;
    }
    const existing = titleOwners.get(normalizedTitle);
    if (existing) {
      pushUniqueDiagnostic(
        diagnostics,
        `Duplicate canonical work-item title detected for "${item.title}".`,
      );
      continue;
    }
    titleOwners.set(normalizedTitle, item.id);
  }
  return diagnostics;
}

function validateCombinedAuthoringBatch(
  newWorkItems: NewWorkItemInput[] | undefined,
  resolvedWorkItems: ResolvedWorkItemInput[] | undefined,
): string[] {
  const diagnostics: string[] = [];
  const newTitles = new Map<string, string>();
  const resolvedTitles = new Map<string, string>();

  for (const item of newWorkItems ?? []) {
    const normalizedTitle = normalizeWorkItemTitle(item.title);
    if (!normalizedTitle) continue;
    if (newTitles.has(normalizedTitle)) {
      pushUniqueDiagnostic(
        diagnostics,
        `Combined authoring batch repeats newWorkItem title "${item.title}".`,
      );
    } else {
      newTitles.set(normalizedTitle, item.title);
    }
  }

  for (const item of resolvedWorkItems ?? []) {
    const normalizedTitle = normalizeWorkItemTitle(item.title);
    if (!normalizedTitle) continue;
    if (resolvedTitles.has(normalizedTitle)) {
      pushUniqueDiagnostic(
        diagnostics,
        `Combined authoring batch repeats resolvedWorkItem title "${item.title}".`,
      );
    } else {
      resolvedTitles.set(normalizedTitle, item.title);
    }
    if (newTitles.has(normalizedTitle)) {
      pushUniqueDiagnostic(
        diagnostics,
        `Combined authoring batch cannot add and resolve "${item.title}" in the same step.`,
      );
    }
  }

  return diagnostics;
}

function detectDependencyCycle(workItems: WorkItem[]): string[] {
  const diagnostics: string[] = [];
  const byId = new Map(workItems.map((item) => [item.id, item] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (itemId: string) => {
    if (visited.has(itemId)) return;
    if (visiting.has(itemId)) {
      const cycleStartIndex = stack.indexOf(itemId);
      const cycleIds =
        cycleStartIndex >= 0
          ? [...stack.slice(cycleStartIndex), itemId]
          : [itemId, itemId];
      const cycleTitles = cycleIds.map((id) => byId.get(id)?.title ?? id);
      pushUniqueDiagnostic(
        diagnostics,
        `Dependency cycle detected: ${cycleTitles.join(" -> ")}.`,
      );
      return;
    }

    visiting.add(itemId);
    stack.push(itemId);
    const item = byId.get(itemId);
    for (const dependencyId of item?.blockedBy ?? []) {
      visit(dependencyId);
    }
    stack.pop();
    visiting.delete(itemId);
    visited.add(itemId);
  };

  for (const item of workItems) visit(item.id);
  return diagnostics;
}

function resolveBlockedDependencyTitles(
  item: WorkItem,
  workItemById: Map<string, WorkItem>,
): string[] {
  const blockedByTitles: string[] = [];
  for (const dependencyId of item.blockedBy ?? []) {
    const dependency = workItemById.get(dependencyId);
    if (!dependency || dependency.status === "done") continue;
    blockedByTitles.push(dependency.title);
  }
  return blockedByTitles;
}

export function projectWorkItems(workItems: WorkItem[]): WorkItemMutationResult {
  const diagnostics = validateCanonicalTitleUniqueness(workItems);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const workItemById = new Map(workItems.map((item) => [item.id, item] as const));
  for (const item of workItems) {
    for (const dependencyId of item.blockedBy ?? []) {
      const dependency = workItemById.get(dependencyId);
      if (!dependency) {
        pushUniqueDiagnostic(
          diagnostics,
          `Work item "${item.title}" depends on missing canonical id "${dependencyId}".`,
        );
        continue;
      }
      if (dependency.id === item.id) {
        pushUniqueDiagnostic(
          diagnostics,
          `Work item "${item.title}" cannot depend on itself.`,
        );
      }
    }
  }

  const cycleDiagnostics = detectDependencyCycle(workItems);
  for (const diagnostic of cycleDiagnostics) {
    pushUniqueDiagnostic(diagnostics, diagnostic);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const unresolvedWorkItems = workItems
    .filter((item) => item.status !== "done")
    .sort(compareReady)
    .map(cloneWorkItem);

  const readyWorkItems = workItems
    .filter((item) => {
      if (item.status !== "open" && item.status !== "in_progress") return false;
      return resolveBlockedDependencyTitles(item, workItemById).length === 0;
    })
    .sort(compareReady)
    .map(cloneWorkItem);

  const blockedWorkSummary = workItems
    .flatMap((item): BlockedWorkSummaryItem[] => {
      if (item.status === "done") return [];

      const blockedByTitles = resolveBlockedDependencyTitles(item, workItemById);
      if (item.status === "blocked") {
        return [
          {
            title: item.title,
            reason: "explicit_blocked",
            details: item.details,
            blockedByTitles: blockedByTitles.length > 0 ? blockedByTitles : undefined,
          },
        ];
      }

      if (
        (item.status === "open" || item.status === "in_progress") &&
        blockedByTitles.length > 0
      ) {
        return [
          {
            title: item.title,
            reason: "unresolved_dependency",
            details: item.details,
            blockedByTitles,
          },
        ];
      }

      return [];
    })
    .sort((left, right) => left.title.localeCompare(right.title));

  return {
    ok: true,
    workItems: workItems.map(cloneWorkItem),
    projection: {
      readyWorkItems,
      blockedWorkSummary,
      unresolvedWorkItems,
      currentFocus: readyWorkItems[0]?.title,
    },
  };
}

export function applyWorkItemBatch(options: {
  currentWorkItems: WorkItem[];
  newWorkItems?: NewWorkItemInput[];
  resolvedWorkItems?: ResolvedWorkItemInput[];
  stepId: string;
  agentName: string;
  updatedAt: string;
}): WorkItemMutationResult {
  const diagnostics = [
    ...validateCanonicalTitleUniqueness(options.currentWorkItems),
    ...validateCombinedAuthoringBatch(
      options.newWorkItems,
      options.resolvedWorkItems,
    ),
  ];
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const candidateWorkItems = options.currentWorkItems.map(cloneWorkItem);
  const titleIndex = buildTitleIndex(candidateWorkItems);
  const authoredDependenciesById = new Map<string, string[]>();

  for (const newWorkItem of options.newWorkItems ?? []) {
    const normalizedTitle = normalizeWorkItemTitle(newWorkItem.title);
    if (!normalizedTitle) continue;

    let candidate = titleIndex.get(normalizedTitle);
    if (candidate) {
      candidate.title = newWorkItem.title;
      candidate.details = newWorkItem.details ?? candidate.details;
      candidate.priority = mergePriority(candidate.priority, newWorkItem.priority);
      candidate.status = candidate.status === "in_progress" ? "in_progress" : "open";
      candidate.updatedAt = options.updatedAt;
    } else {
      candidate = {
        id: createWorkItemId(newWorkItem.title),
        title: newWorkItem.title,
        details: newWorkItem.details,
        status: "open",
        priority: newWorkItem.priority,
        blockedBy: undefined,
        sourceStepId: options.stepId,
        sourceAgent: options.agentName,
        updatedAt: options.updatedAt,
      };
      candidateWorkItems.push(candidate);
      titleIndex.set(normalizedTitle, candidate);
    }

    if (Object.prototype.hasOwnProperty.call(newWorkItem, "blockedByTitles")) {
      authoredDependenciesById.set(
        candidate.id,
        normalizeOptionalTitles(newWorkItem.blockedByTitles),
      );
    }
  }

  for (const resolvedWorkItem of options.resolvedWorkItems ?? []) {
    const normalizedTitle = normalizeWorkItemTitle(resolvedWorkItem.title);
    if (!normalizedTitle) continue;

    const existing = titleIndex.get(normalizedTitle);
    if (existing) {
      existing.title = resolvedWorkItem.title;
      existing.status = "done";
      existing.blockedBy = undefined;
      existing.updatedAt = options.updatedAt;
      continue;
    }

    const created: WorkItem = {
      id: createWorkItemId(resolvedWorkItem.title),
      title: resolvedWorkItem.title,
      status: "done",
      blockedBy: undefined,
      sourceStepId: options.stepId,
      sourceAgent: options.agentName,
      updatedAt: options.updatedAt,
    };
    candidateWorkItems.push(created);
    titleIndex.set(normalizedTitle, created);
  }

  const resolvedTitleIndex = buildTitleIndex(candidateWorkItems);
  for (const item of candidateWorkItems) {
    if (item.status === "done") {
      item.blockedBy = undefined;
      continue;
    }

    const authoredDependencyTitles = authoredDependenciesById.get(item.id);
    if (!authoredDependencyTitles) continue;

    const resolvedBlockedBy: string[] = [];
    for (const dependencyTitle of authoredDependencyTitles) {
      const dependency = resolvedTitleIndex.get(normalizeWorkItemTitle(dependencyTitle));
      if (!dependency) {
        pushUniqueDiagnostic(
          diagnostics,
          `Work item "${item.title}" depends on unknown title "${dependencyTitle}".`,
        );
        continue;
      }
      if (dependency.id === item.id) {
        pushUniqueDiagnostic(
          diagnostics,
          `Work item "${item.title}" cannot depend on itself.`,
        );
        continue;
      }
      if (!resolvedBlockedBy.includes(dependency.id)) {
        resolvedBlockedBy.push(dependency.id);
      }
    }

    item.blockedBy = resolvedBlockedBy.length > 0 ? resolvedBlockedBy : undefined;
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return projectWorkItems(candidateWorkItems);
}

export function getReadyWorkItems(workItems: WorkItem[]): WorkItem[] {
  const projection = projectWorkItems(workItems);
  return projection.ok ? projection.projection.readyWorkItems : [];
}

export function getUnresolvedWorkItems(workItems: WorkItem[]): WorkItem[] {
  const projection = projectWorkItems(workItems);
  return projection.ok ? projection.projection.unresolvedWorkItems : [];
}

export function getDoneWorkItems(workItems: WorkItem[]): WorkItem[] {
  return workItems
    .filter((item) => item.status === "done")
    .sort(compareByUpdatedAtDesc)
    .map(cloneWorkItem);
}

export function getBlockedWorkItems(workItems: WorkItem[]): WorkItem[] {
  return workItems
    .filter((item) => item.status === "blocked")
    .sort(compareByUpdatedAtDesc)
    .map(cloneWorkItem);
}

export function getRecentResolvedWorkItems(
  workItems: WorkItem[],
  limit = RECENT_RESOLVED_DEFAULT_LIMIT,
): WorkItem[] {
  return getDoneWorkItems(workItems).slice(0, limit);
}

export function findWorkItemByTitle(
  workItems: WorkItem[],
  title: string,
): WorkItem | undefined {
  const normalizedTitle = normalizeWorkItemTitle(title);
  if (!normalizedTitle) return undefined;
  return workItems.find(
    (item) => normalizeWorkItemTitle(item.title) === normalizedTitle,
  );
}
