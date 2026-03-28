import type {
  ArtifactItem,
  BlockedWorkSummaryItem,
  BlockerItem,
  DecisionItem,
  VerificationItem,
  WorkItem,
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

function formatWorkItem(item: WorkItem): string {
  const parts = [item.title];
  if (item.priority) parts.push(`priority: ${item.priority}`);
  parts.push(`status: ${item.status}`);
  if (item.blockedBy?.length) parts.push(`blockedBy: ${item.blockedBy.length} item(s)`);
  if (item.details) parts.push(item.details);
  return `- ${parts.join(" | ")}`;
}

function formatBlockedWorkSummary(item: BlockedWorkSummaryItem): string {
  const parts = [item.title, `reason: ${item.reason}`];
  if (item.blockedByTitles?.length) {
    parts.push(`waiting on: ${item.blockedByTitles.join(", ")}`);
  }
  if (item.details) parts.push(item.details);
  return `- ${parts.join(" | ")}`;
}

function renderListSection(title: string, values: string[]): string[] {
  if (values.length === 0) return [title, "- None", ""];
  const shown = values.slice(0, MAX_CONTEXT_ITEMS);
  const lines = [title, ...shown];
  if (values.length > shown.length) {
    lines.push(`- ... ${values.length - shown.length} more item(s) omitted`);
  }
  lines.push("");
  return lines;
}

function renderRequiredSection(title: string, values: string[]): string[] {
  const lines = [title];
  if (values.length === 0) {
    lines.push("- None");
  } else {
    for (const value of values) lines.push(`- ${value}`);
  }
  lines.push("");
  return lines;
}

export function renderStructuredStepPrompt(workOrder: WorkOrder): string {
  const isPlanningStep = workOrder.profile === "planning" || workOrder.agent === "plan";
  const lines: string[] = [
    "TASK",
    workOrder.context.userTask,
    "",
    "OBJECTIVE",
    workOrder.objective,
    "",
    "CURRENT FOCUS",
    workOrder.context.currentFocus?.trim() || "No explicit focus yet.",
    "",
  ];

  lines.push(
    ...renderListSection(
      "READY WORK ITEMS",
      (workOrder.context.readyWorkItems ?? []).map(formatWorkItem),
    ),
  );
  lines.push(
    ...renderListSection(
      "BLOCKED WORK SUMMARY",
      (workOrder.context.blockedWorkSummary ?? []).map(formatBlockedWorkSummary),
    ),
  );
  lines.push(
    ...renderListSection(
      "RECENTLY RESOLVED WORK",
      (workOrder.context.recentResolvedWorkItems ?? []).map(formatWorkItem),
    ),
  );

  lines.push("CONTEXT");
  if (workOrder.agentDescription?.trim()) {
    lines.push(`Agent specialty: ${workOrder.agentDescription.trim()}`);
  }
  if (workOrder.profile?.trim()) {
    lines.push(`Resolved profile: ${workOrder.profile}`);
  }
  if (workOrder.context.summary?.trim()) {
    lines.push(`Shared summary: ${workOrder.context.summary.trim()}`);
  }
  lines.push("");

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
    ...renderRequiredSection("CONSTRAINTS", [
      ...workOrder.constraints,
      ...(workOrder.profileGuidance ?? []),
      ...(isPlanningStep
        ? [
            "For planning steps, describe implementation as future work unless inspection confirmed it already exists.",
            "Do not claim file edits or task completion from planning-only inspection.",
          ]
        : []),
    ]),
  );
  lines.push(
    ...renderRequiredSection(
      "ALLOWED TOOLS",
      workOrder.allowedTools?.length
        ? workOrder.allowedTools
        : ["Use the agent's normal runtime tool policy."],
    ),
  );
  lines.push(
    ...renderRequiredSection("DEFINITION OF DONE", [
      ...(workOrder.definitionOfDone ?? []),
      "Return the structured workflow result block exactly once.",
    ]),
  );
  lines.push(
    ...renderRequiredSection("REQUIRED EVIDENCE", [
      ...(workOrder.requiredEvidence ?? []),
      "Use evidenceHints when files, artifacts, symbols, or commands would help the runtime verify this step.",
    ]),
  );

  lines.push("RESPONSE CONTRACT");
  lines.push(
    `Return exactly one JSON object between ${WORKFLOW_RESULT_BEGIN} and ${WORKFLOW_RESULT_END}.`,
  );
  lines.push(`Expected output channels: ${workOrder.expectedOutput.join(", ")}`);
  lines.push("Required fields: `status`, `summary`.");
  lines.push(
    "Optional fields when materially relevant: `decisions`, `artifacts`, `learnings`, `blockers`, `verification`, `newWorkItems` (with optional `blockedByTitles`), `resolvedWorkItems`, `focusSummary`, `nextStepHint`, `evidenceHints`.",
  );
  lines.push("");
  lines.push("Marker block template:");
  lines.push(WORKFLOW_RESULT_BEGIN);
  lines.push("{");
  lines.push('  "status": "success",');
  lines.push('  "summary": "Short summary of the step outcome",');
  lines.push('  "decisions": [],');
  lines.push('  "artifacts": [],');
  lines.push('  "learnings": [],');
  lines.push('  "blockers": [],');
  lines.push('  "verification": [],');
  lines.push('  "newWorkItems": [');
  lines.push("    {");
  lines.push('      "title": "Actionable follow-up task",');
  lines.push('      "details": "Optional detail",');
  lines.push('      "priority": "medium",');
  lines.push('      "blockedByTitles": ["Optional prerequisite title"]');
  lines.push("    }");
  lines.push("  ],");
  lines.push('  "resolvedWorkItems": [');
  lines.push("    {");
  lines.push('      "title": "Completed task title",');
  lines.push('      "resolution": "Optional completion note"');
  lines.push("    }");
  lines.push("  ],");
  lines.push('  "focusSummary": "Short note about the best next focus",');
  lines.push('  "nextStepHint": "Optional hint for the workflow orchestrator",');
  lines.push('  "evidenceHints": {');
  lines.push('    "touchedFiles": [],');
  lines.push('    "artifactPaths": [],');
  lines.push('    "symbols": [],');
  lines.push('    "commands": []');
  lines.push("  }");
  lines.push("}");
  lines.push(WORKFLOW_RESULT_END);
  lines.push("");
  lines.push("You may include additional natural-language explanation after the marker block.");

  return lines.join("\n");
}

export function renderRepairPrompt(rawText: string, parseError: string): string {
  return [
    "You are repairing a workflow step response into the required structured result format.",
    "Do not invent new repository changes. Extract only what is justified by the original response.",
    "If information is unknown, leave optional arrays empty and omit optional strings.",
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
    '- `status`: one of "success" or "failed"',
    '- `summary`: concise string',
    "Optional fields:",
    "- `decisions`",
    "- `artifacts`",
    "- `learnings`",
    "- `blockers`",
    "- `verification`",
    "- `newWorkItems` with optional `blockedByTitles`",
    "- `resolvedWorkItems`",
    "- `focusSummary`",
    "- `nextStepHint`",
    "- `evidenceHints` with `touchedFiles`, `artifactPaths`, `symbols`, `commands`",
    "",
    WORKFLOW_RESULT_BEGIN,
    "{",
    '  "status": "success",',
    '  "summary": "...",',
    '  "newWorkItems": [{"title": "...", "blockedByTitles": []}],',
    '  "resolvedWorkItems": [],',
    '  "evidenceHints": { "touchedFiles": [] }',
    "}",
    WORKFLOW_RESULT_END,
  ].join("\n");
}
