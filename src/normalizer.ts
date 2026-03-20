// src/normalizer.ts - Normalize parsed agents into AgentSpec

import type { AgentSource, StructuredError } from "./errors";
import {
  missingRequiredFieldError,
  invalidFieldTypeError,
  invalidIdError,
  duplicateIdError,
} from "./errors";
import { ParsedAgent } from "./parser";

export interface AgentSpec {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;

  tools?: string[];
  model?: string;

  role?: string;
  capabilities?: string[];
  priority?: number;
  readOnly?: boolean;
  timeoutMs?: number;
  tags?: string[];

  source: AgentSource;
  filePath?: string;
  metadata?: Record<string, unknown>;
}

// Known frontmatter keys (Phase 1)
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "role",
  "capabilities",
  "priority",
  "readOnly",
  "timeoutMs",
  "tags",
]);

/**
 * Normalize a filename (without .md) to a kebab-case ID.
 * - Convert to lowercase
 * - Replace spaces, underscores, dots, and multiple hyphens with single hyphen
 * - Trim leading and trailing hyphens
 * - Preserve Unicode characters exactly as written
 */
export function normalizeId(filename: string): string {
  return filename
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Check if an ID is valid (non-empty after normalization).
 */
export function isValidId(id: string): boolean {
  const normalized = normalizeId(id);
  return normalized.length > 0;
}

/**
 * Deduplicate an array of strings while preserving first-seen order.
 */
export function deduplicateStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

/**
 * Validate and normalize a field type.
 */
function validateField(
  key: string,
  value: unknown,
  expected: "string" | "number" | "boolean" | "string[]",
  errors: StructuredError[],
  source?: string
): void {
  const actualType = Array.isArray(value) ? "array" : typeof value;

  switch (expected) {
    case "string":
      if (actualType !== "string") {
        errors.push(invalidFieldTypeError(key, "string", value, source));
      }
      break;
    case "number":
      if (actualType !== "number") {
        errors.push(invalidFieldTypeError(key, "number", value, source));
      }
      break;
    case "boolean":
      if (actualType !== "boolean") {
        errors.push(invalidFieldTypeError(key, "boolean", value, source));
      }
      break;
    case "string[]":
      if (actualType !== "array") {
        errors.push(invalidFieldTypeError(key, "array of strings", value, source));
      } else if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        errors.push(invalidFieldTypeError(key, "array of strings", value, source));
      }
      break;
  }
}

export interface NormalizedAgent {
  spec: AgentSpec;
  rawId: string;
}

export interface NormalizationResult {
  agent?: NormalizedAgent;
  errors: StructuredError[];
}

/**
 * Normalize a parsed agent into AgentSpec.
 */
export function normalizeAgent(
  parsed: ParsedAgent,
  rawId: string,
  source: AgentSource,
  filePath?: string,
  sourceFile?: string
): NormalizationResult {
  const errors: StructuredError[] = [];
  const fm = parsed.frontmatter!; // Already validated by parser

  // Validate required field: name
  const name = fm.name;
  if (name === undefined || name === null) {
    errors.push(missingRequiredFieldError("name", sourceFile));
  } else if (typeof name !== "string" || !name.trim()) {
    errors.push(missingRequiredFieldError("name", sourceFile));
  }

  // Derive ID from filename
  const id = normalizeId(rawId);
  if (!isValidId(id)) {
    errors.push(invalidIdError(rawId, sourceFile));
  }

  // If there are errors so far, return early
  if (errors.length > 0) {
    return { errors };
  }

  // Validate optional fields and collect unknown ones
  const metadata: Record<string, unknown> = {};
  const spec: AgentSpec = {
    id,
    name: name as string,
    systemPrompt: parsed.body,
    source,
    ...(filePath && { filePath }),
  };

  for (const [key, value] of Object.entries(fm)) {
    if (KNOWN_FIELDS.has(key)) {
      // Validate known fields
      switch (key) {
        case "description":
        case "model":
        case "role":
          if (value !== undefined && value !== null) {
            validateField(key, value, "string", errors, sourceFile);
            if (errors.length === 0 || !errors.some((e) => e.field === key)) {
              // Only add if valid or no error for this field yet
              if (typeof value === "string") {
                (spec as unknown as Record<string, unknown>)[key] = value;
              }
            }
          }
          break;
        case "tools":
        case "capabilities":
        case "tags":
          if (value !== undefined && value !== null) {
            if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
              (spec as unknown as Record<string, unknown>)[key] = deduplicateStrings(value as string[]);
            } else {
              validateField(key, value, "string[]", errors, sourceFile);
            }
          }
          break;
        case "priority":
        case "timeoutMs":
          if (value !== undefined && value !== null) {
            if (typeof value === "number") {
              (spec as unknown as Record<string, unknown>)[key] = value;
            } else {
              validateField(key, value, "number", errors, sourceFile);
            }
          }
          break;
        case "readOnly":
          if (value !== undefined && value !== null) {
            if (typeof value === "boolean") {
              (spec as unknown as Record<string, unknown>)[key] = value;
            } else {
              validateField(key, value, "boolean", errors, sourceFile);
            }
          }
          break;
      }
    } else {
      // Unknown field - add to metadata
      metadata[key] = value;
    }
  }

  // Add metadata if not empty
  if (Object.keys(metadata).length > 0) {
    spec.metadata = metadata;
  }

  return {
    agent: { spec, rawId },
    errors,
  };
}

/**
 * Detect duplicate IDs within a single source.
 */
export interface DuplicateDetectionResult {
  duplicates: Array<{
    id: string;
    files: string[];
  }>;
}

export function detectDuplicateIds(
  agents: Array<{ id: string; filePath?: string; source: string }>
): DuplicateDetectionResult {
  const byId = new Map<string, string[]>();

  for (const agent of agents) {
    const existing = byId.get(agent.id) || [];
    if (agent.filePath) {
      existing.push(agent.filePath);
    }
    byId.set(agent.id, existing);
  }

  const duplicates: DuplicateDetectionResult["duplicates"] = [];

  for (const [id, files] of byId) {
    // Only report as duplicate if there are multiple DIFFERENT files
    const uniqueFiles = [...new Set(files)];
    if (uniqueFiles.length > 1) {
      duplicates.push({ id, files: uniqueFiles });
    }
  }

  return { duplicates };
}

/**
 * Merge duplicate-ID errors for same source.
 */
export function createDuplicateErrors(duplicates: DuplicateDetectionResult["duplicates"]): StructuredError[] {
  return duplicates.map((d) =>
    duplicateIdError(
      d.id,
      d.files.length > 0 ? d.files[0] : undefined
    )
  );
}
