import type {
  AgentResult,
  ArtifactItem,
  BlockerItem,
  DecisionItem,
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
  };
}

function normalizeNewWorkItem(value: unknown): NewWorkItemInput | undefined {
  if (!isObject(value)) return undefined;
  const title = normalizeText(value.title);
  if (!title) return undefined;
  const priority = normalizeText(value.priority);
  return {
    title,
    details: normalizeText(value.details),
    priority:
      priority === "low" || priority === "medium" || priority === "high"
        ? priority
        : undefined,
  };
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
