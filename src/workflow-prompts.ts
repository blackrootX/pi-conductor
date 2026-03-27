import type {
  ArtifactItem,
  BlockerItem,
  DecisionItem,
  VerificationItem,
  WorkOrder,
} from "./workflow-types.js";

export const WORKFLOW_RESULT_BEGIN = "[WORKFLOW_RESULT_BEGIN]";
export const WORKFLOW_RESULT_END = "[WORKFLOW_RESULT_END]";

const MAX_CONTEXT_ITEMS = 12;

function formatDecision(item: DecisionItem): string {
  return `- ${item.topic}: ${item.decision}${item.rationale ? ` (${item.rationale})` : ""}`;
}

function formatArtifact(item: ArtifactItem): string {
  if (item.path && item.text) return `- ${item.kind}: ${item.path} (${item.text})`;
  if (item.path) return `- ${item.kind}: ${item.path}`;
  if (item.text) return `- ${item.kind}: ${item.text}`;
  return `- ${item.kind}`;
}

function formatBlocker(item: BlockerItem): string {
  return `- ${item.issue}${item.needs ? ` (needs: ${item.needs})` : ""}`;
}

function formatVerification(item: VerificationItem): string {
  return `- ${item.check}: ${item.status}${item.notes ? ` (${item.notes})` : ""}`;
}

function renderListSection(
  title: string,
  values: string[],
): string[] {
  if (values.length === 0) return [];
  const shown = values.slice(0, MAX_CONTEXT_ITEMS);
  const lines = [title, ...shown];
  if (values.length > shown.length) {
    lines.push(`- ... ${values.length - shown.length} more item(s) omitted`);
  }
  lines.push("");
  return lines;
}

export function renderStructuredStepPrompt(workOrder: WorkOrder): string {
  const lines: string[] = [
    "TASK",
    workOrder.context.userTask,
    "",
    "STEP OBJECTIVE",
    workOrder.objective,
    "",
    "CURRENT CONTEXT",
  ];

  if (workOrder.context.summary?.trim()) {
    lines.push("Summary:");
    lines.push(workOrder.context.summary.trim());
    lines.push("");
  }

  lines.push(
    ...renderListSection(
      "Decisions:",
      (workOrder.context.decisions ?? []).map(formatDecision),
    ),
  );
  lines.push(
    ...renderListSection(
      "Artifacts:",
      (workOrder.context.artifacts ?? []).map(formatArtifact),
    ),
  );
  lines.push(
    ...renderListSection(
      "Learnings:",
      (workOrder.context.learnings ?? []).map((item) => `- ${item}`),
    ),
  );
  lines.push(
    ...renderListSection(
      "Blockers:",
      (workOrder.context.blockers ?? []).map(formatBlocker),
    ),
  );
  lines.push(
    ...renderListSection(
      "Verification:",
      (workOrder.context.verification ?? []).map(formatVerification),
    ),
  );

  lines.push(
    "MUST DO",
    "- You are completing one workflow step for the orchestrator.",
    "- Return a structured workflow result even if you also include human-readable explanation.",
    "- Include at least `status` and `summary` in the required result block.",
    "- Include `artifacts`, `decisions`, `learnings`, `blockers`, and `verification` when they are materially relevant.",
    "",
    "MUST NOT DO",
    "- Do not address the next agent directly.",
    "- Do not omit the required result block.",
    "- Do not rely on free-form prose alone for important workflow state.",
    "",
    "EXPECTED OUTPUT CHANNELS",
    workOrder.expectedOutput.join(", "),
    "",
    "RESPONSE CONTRACT",
    `Return exactly one JSON object between ${WORKFLOW_RESULT_BEGIN} and ${WORKFLOW_RESULT_END}.`,
    "Marker block template:",
    WORKFLOW_RESULT_BEGIN,
    '{',
    '  "status": "success",',
    '  "summary": "Short summary of the step outcome",',
    '  "decisions": [],',
    '  "artifacts": [],',
    '  "learnings": [],',
    '  "blockers": [],',
    '  "verification": []',
    '}',
    WORKFLOW_RESULT_END,
    "",
    "You may include additional natural-language explanation after the marker block.",
  );

  return lines.join("\n");
}

export function renderRepairPrompt(rawText: string, parseError: string): string {
  return [
    "You are repairing a workflow step response into the required structured result format.",
    "Do not invent new repository changes. Extract only what is justified by the original response.",
    "If information is unknown, leave optional arrays empty.",
    "",
    "PARSE ERROR",
    parseError,
    "",
    "ORIGINAL RESPONSE",
    rawText.trim() || "(empty response)",
    "",
    "RESPONSE CONTRACT",
    `Return exactly one JSON object between ${WORKFLOW_RESULT_BEGIN} and ${WORKFLOW_RESULT_END}.`,
    "Required fields:",
    '- `status`: one of "success", "blocked", or "failed"',
    '- `summary`: concise string',
    "Optional fields:",
    "- `decisions`",
    "- `artifacts`",
    "- `learnings`",
    "- `blockers`",
    "- `verification`",
    "",
    WORKFLOW_RESULT_BEGIN,
    '{',
    '  "status": "success",',
    '  "summary": "..."',
    '}',
    WORKFLOW_RESULT_END,
  ].join("\n");
}
