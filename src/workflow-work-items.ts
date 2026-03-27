import { createHash } from "node:crypto";
import type { WorkItem } from "./workflow-types.js";

const RECENT_RESOLVED_DEFAULT_LIMIT = 5;

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
  const normalizedTitle = normalizeWorkItemTitle(title) || normalizeWhitespace(title).toLowerCase() || "work-item";
  const digest = createHash("sha1").update(normalizedTitle).digest("hex").slice(0, 12);
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

function compareUnresolved(left: WorkItem, right: WorkItem): number {
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

export function getOpenWorkItems(workItems: WorkItem[]): WorkItem[] {
  return workItems
    .filter((item) => item.status === "open" || item.status === "in_progress")
    .sort(compareByPriority);
}

export function getUnresolvedWorkItems(workItems: WorkItem[]): WorkItem[] {
  return workItems
    .filter((item) => item.status !== "done")
    .sort(compareUnresolved);
}

export function getDoneWorkItems(workItems: WorkItem[]): WorkItem[] {
  return workItems
    .filter((item) => item.status === "done")
    .sort(compareByUpdatedAtDesc);
}

export function getBlockedWorkItems(workItems: WorkItem[]): WorkItem[] {
  return workItems
    .filter((item) => item.status === "blocked")
    .sort(compareByUpdatedAtDesc);
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
  return workItems.find((item) => normalizeWorkItemTitle(item.title) === normalizedTitle);
}

export function findWorkItemForBlocker(
  workItems: WorkItem[],
  issue: string,
): WorkItem | undefined {
  const normalizedIssue = normalizeWorkItemTitle(issue);
  if (!normalizedIssue) return undefined;

  return workItems.find((item) => {
    if (item.status === "done") return false;
    const normalizedTitle = normalizeWorkItemTitle(item.title);
    return (
      normalizedTitle === normalizedIssue ||
      normalizedTitle.includes(normalizedIssue) ||
      normalizedIssue.includes(normalizedTitle)
    );
  });
}
