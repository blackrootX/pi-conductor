import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  "plan-style": [
    "Stay in planning mode.",
    "Inspect the repository and turn the task into concise, implementation-ready guidance for a later execution step.",
    "Do not modify files, create files, or execute implementation work yourself.",
    "Use the structured result to propose newWorkItems, blockers, verification, and the next focus.",
  ].join("\n"),
  "build-style": [
    "Treat the provided context as work to execute, not just discuss.",
    "Inspect the repository, make the required changes, and explain what you completed.",
    "Prefer concrete execution over high-level planning.",
    "Use the structured result to record what you changed, what remains, and any blockers or verification.",
  ].join("\n"),
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
): string {
  const fragments = internalIncludes.map(loadInternalInclude);
  const trimmedRolePrompt = rolePrompt.trim();

  return [...fragments, trimmedRolePrompt]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n");
}
