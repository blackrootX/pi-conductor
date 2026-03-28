import type {
  AgentResult,
  ArtifactItem,
  BlockerItem,
  DecisionItem,
  EvidenceHints,
  NewWorkItemInput,
  ResolvedWorkItemInput,
  VerificationItem,
} from "./workflow-types.js";
import { WORKFLOW_RESULT_BEGIN, WORKFLOW_RESULT_END } from "./workflow-prompts.js";

type ParseAgentResultOk = {
  ok: true;
  result: AgentResult;
};

type ParseAgentResultError = {
  ok: false;
  error: string;
};

export type ParseAgentResultOutcome = ParseAgentResultOk | ParseAgentResultError;

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDecisionItem(value: unknown): DecisionItem | undefined {
  if (!isObject(value)) return undefined;
  const topic = normalizeText(value.topic);
  const decision = normalizeText(value.decision);
  if (!topic || !decision) return undefined;
  return {
    topic,
    decision,
    rationale: normalizeText(value.rationale),
  };
}

function normalizeArtifactItem(value: unknown): ArtifactItem | undefined {
  if (!isObject(value)) return undefined;
  const kind = normalizeText(value.kind);
  if (!kind) return undefined;
  const path = normalizeText(value.path);
  const text = normalizeText(value.text);
  return { kind, path, text };
}

function normalizeBlockerItem(value: unknown): BlockerItem | undefined {
  if (!isObject(value)) return undefined;
  const issue = normalizeText(value.issue);
  if (!issue) return undefined;
  return {
    issue,
    needs: normalizeText(value.needs),
  };
}

function normalizeVerificationItem(value: unknown): VerificationItem | undefined {
  if (!isObject(value)) return undefined;
  const check = normalizeText(value.check);
  const status = normalizeText(value.status);
  if (!check || (status !== "pass" && status !== "fail" && status !== "not_run")) {
    return undefined;
  }
  return {
    check,
    status,
    notes: normalizeText(value.notes),
    kind:
      normalizeText(value.kind) === "file_exists" ||
      normalizeText(value.kind) === "grep_assertion" ||
      normalizeText(value.kind) === "diagnostic" ||
      normalizeText(value.kind) === "claimed"
        ? (normalizeText(value.kind) as VerificationItem["kind"])
        : undefined,
    path: normalizeText(value.path),
    source:
      normalizeText(value.source) === "worker" || normalizeText(value.source) === "runtime"
        ? (normalizeText(value.source) as VerificationItem["source"])
        : undefined,
  };
}

function normalizeNewWorkItem(value: unknown): NewWorkItemInput | undefined {
  if (!isObject(value)) return undefined;
  const title = normalizeText(value.title);
  if (!title) return undefined;
  const priority = normalizeText(value.priority);
  const blockedByTitles = Array.isArray(value.blockedByTitles)
    ? value.blockedByTitles
        .map((item) => normalizeText(item))
        .filter((item): item is string => Boolean(item))
    : undefined;
  return {
    title,
    details: normalizeText(value.details),
    priority:
      priority === "low" || priority === "medium" || priority === "high"
        ? priority
        : undefined,
    ...(Array.isArray(value.blockedByTitles) ? { blockedByTitles } : {}),
  };
}

function validateNewWorkItemArray(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return "`newWorkItems` must be an array when provided.";
  }

  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      return `newWorkItems[${index}] must be an object.`;
    }
    if (!normalizeText(item.title)) {
      return `newWorkItems[${index}].title must be a non-empty string.`;
    }
    if (!Object.prototype.hasOwnProperty.call(item, "blockedByTitles")) continue;
    if (!Array.isArray(item.blockedByTitles)) {
      return `newWorkItems[${index}].blockedByTitles must be an array of non-empty strings when provided.`;
    }
    for (const dependencyTitle of item.blockedByTitles) {
      if (!normalizeText(dependencyTitle)) {
        return `newWorkItems[${index}].blockedByTitles must contain only non-empty strings.`;
      }
    }
  }

  return undefined;
}

function normalizeResolvedWorkItem(value: unknown): ResolvedWorkItemInput | undefined {
  if (!isObject(value)) return undefined;
  const title = normalizeText(value.title);
  if (!title) return undefined;
  return {
    title,
    resolution: normalizeText(value.resolution),
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => normalizeText(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function normalizeEvidenceHints(value: unknown): EvidenceHints | undefined {
  if (!isObject(value)) return undefined;
  const evidenceHints: EvidenceHints = {
    touchedFiles: normalizeStringArray(value.touchedFiles),
    artifactPaths: normalizeStringArray(value.artifactPaths),
    symbols: normalizeStringArray(value.symbols),
    commands: normalizeStringArray(value.commands),
  };
  return Object.values(evidenceHints).some(Boolean) ? evidenceHints : undefined;
}

function normalizeObjectArray<T>(
  value: unknown,
  normalizer: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => normalizer(item))
    .filter((item): item is T => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function extractStructuredBlock(text: string): string | undefined {
  const markerPattern = new RegExp(
    `${WORKFLOW_RESULT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${WORKFLOW_RESULT_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  const markerMatch = text.match(markerPattern);
  if (markerMatch?.[1]) return stripJsonFences(markerMatch[1]);

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return undefined;
}

export function validateAgentResultShape(
  value: unknown,
  rawText: string,
): ParseAgentResultOutcome {
  if (!isObject(value)) {
    return { ok: false, error: "Structured result must be a JSON object." };
  }

  const status = normalizeText(value.status);
  if (status !== "success" && status !== "blocked" && status !== "failed") {
    return {
      ok: false,
      error: 'Structured result requires `status` to be one of "success", "blocked", or "failed".',
    };
  }

  const summary = normalizeText(value.summary);
  if (!summary) {
    return {
      ok: false,
      error: "Structured result requires a non-empty `summary` string.",
    };
  }

  const newWorkItemsError = validateNewWorkItemArray(value.newWorkItems);
  if (newWorkItemsError) {
    return {
      ok: false,
      error: newWorkItemsError,
    };
  }

  return {
    ok: true,
    result: {
      status,
      summary,
      decisions: normalizeObjectArray(value.decisions, normalizeDecisionItem),
      artifacts: normalizeObjectArray(value.artifacts, normalizeArtifactItem),
      learnings: normalizeStringArray(value.learnings),
      blockers: normalizeObjectArray(value.blockers, normalizeBlockerItem),
      verification: normalizeObjectArray(value.verification, normalizeVerificationItem),
      newWorkItems: normalizeObjectArray(value.newWorkItems, normalizeNewWorkItem),
      resolvedWorkItems: normalizeObjectArray(value.resolvedWorkItems, normalizeResolvedWorkItem),
      focusSummary: normalizeText(value.focusSummary),
      nextStepHint: normalizeText(value.nextStepHint),
      evidenceHints: normalizeEvidenceHints(value.evidenceHints),
      rawText,
    },
  };
}

export function parseAgentResult(text: string): ParseAgentResultOutcome {
  const block = extractStructuredBlock(text);
  if (!block) {
    return {
      ok: false,
      error: `Missing structured result block between ${WORKFLOW_RESULT_BEGIN} and ${WORKFLOW_RESULT_END}.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `Invalid JSON in structured result: ${error.message}` : "Invalid JSON in structured result.",
    };
  }

  return validateAgentResultShape(parsed, text);
}
