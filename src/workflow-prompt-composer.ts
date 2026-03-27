import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionProfile } from "./workflow-types.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INCLUDE_DIR_CANDIDATES = [
  path.join(MODULE_DIR, "includes"),
  path.join(MODULE_DIR, "src", "includes"),
  path.join(MODULE_DIR, "..", "src", "includes"),
];
const includeCache = new Map<string, string>();
const EMBEDDED_INTERNAL_INCLUDES: Record<string, string> = {
  "workflow-role-common": [
    "You are one step inside a coding workflow coordinated by an orchestrator.",
    "Inspect the repository and treat the provided workflow context as the current source of truth.",
    "You are reporting to the workflow orchestrator, not directly to the next agent.",
    "Follow the runtime response contract exactly.",
  ].join("\n"),
  "done-criteria": [
    "Use the definition-of-done section as the concrete success contract for this step.",
    "Do not claim the step is complete unless the done criteria are satisfied by your actual work.",
  ].join("\n"),
  "evidence-style": [
    "Return concrete evidence hints for touched files, artifacts, symbols, and commands when relevant.",
    "Treat evidence hints as claims for the runtime to inspect later, not as self-verifying proof.",
  ].join("\n"),
  "verify-style": [
    "The runtime owns verification after your step completes.",
    "Do not present your own verification claims as authoritative final truth.",
  ].join("\n"),
  "implementation-guardrails": [
    "Prefer the smallest concrete change that satisfies the objective.",
    "Keep claims tied to repository evidence and do not invent side effects you did not perform.",
  ].join("\n"),
  "plan-style": [
    "Stay in planning mode.",
    "Inspect the repository and turn the task into concise, implementation-ready guidance for a later execution step.",
    "Do not modify files, create files, or execute implementation work yourself.",
    "Use the structured result to propose newWorkItems, blockers, verification, and the next focus.",
  ].join("\n"),
  "explore-style": [
    "Stay in exploration mode.",
    "Inspect existing code and gather evidence without making repository changes.",
    "Prefer concrete findings, paths, and symbols over broad speculation.",
  ].join("\n"),
  "build-style": [
    "Treat the provided context as work to execute, not just discuss.",
    "Inspect the repository, make the required changes, and explain what you completed.",
    "Prefer concrete execution over high-level planning.",
    "Use the structured result to record what you changed, what remains, and any blockers or verification.",
  ].join("\n"),
  "verify-context-style": [
    "Treat this step as evidence gathering for later runtime verification.",
    "Return precise evidence hints and candidate proof points, but do not self-certify the final outcome.",
  ].join("\n"),
};

const PROFILE_INCLUDES: Record<ExecutionProfile, string[]> = {
  planning: ["plan-style"],
  explore: ["explore-style"],
  implement: ["build-style", "implementation-guardrails"],
  "verify-context": ["explore-style", "verify-context-style"],
};

function findIncludeFilePath(includeId: string): string | undefined {
  for (const candidateDir of INCLUDE_DIR_CANDIDATES) {
    const candidatePath = path.join(candidateDir, `${includeId}.md`);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  return undefined;
}

function normalizeIncludeId(includeId: string): string {
  return includeId.trim().replace(/\.md$/i, "");
}

export function loadInternalInclude(includeId: string): string {
  const normalizedId = normalizeIncludeId(includeId);
  const cached = includeCache.get(normalizedId);
  if (cached) return cached;

  const filePath = findIncludeFilePath(normalizedId);
  if (filePath) {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) {
      throw new Error(`Internal include "${normalizedId}" is empty.`);
    }

    includeCache.set(normalizedId, content);
    return content;
  }

  const embeddedFallback = EMBEDDED_INTERNAL_INCLUDES[normalizedId]?.trim();
  if (embeddedFallback) {
    includeCache.set(normalizedId, embeddedFallback);
    return embeddedFallback;
  }

  throw new Error(
    `Missing internal include "${normalizedId}". Looked in: ${INCLUDE_DIR_CANDIDATES.join(", ")}`,
  );
}

export function composeBuiltInPrompt(
  rolePrompt: string,
  internalIncludes: readonly string[],
  profile?: ExecutionProfile,
): string {
  const includeIds = [
    ...internalIncludes,
    ...(profile ? PROFILE_INCLUDES[profile] ?? [] : []),
  ].filter(Boolean);
  const fragments = Array.from(new Set(includeIds)).map(loadInternalInclude);
  const trimmedRolePrompt = rolePrompt.trim();

  return [...fragments, trimmedRolePrompt]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n");
}
