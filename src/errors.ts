// src/errors.ts - Structured error types for agent parsing and normalization

export type AgentSource = "built-in" | "user" | "project";

export type ErrorCode =
  | "invalid_frontmatter"
  | "invalid_yaml"
  | "missing_required_field"
  | "invalid_field_type"
  | "empty_body"
  | "invalid_id"
  | "duplicate_id";

export interface StructuredError {
  code: ErrorCode;
  message: string;
  source?: string;
  field?: string;
}

export function createError(
  code: ErrorCode,
  message: string,
  options?: { source?: string; field?: string }
): StructuredError {
  return {
    code,
    message,
    ...(options?.source !== undefined && { source: options.source }),
    ...(options?.field !== undefined && { field: options.field }),
  };
}

export function invalidFrontmatterError(source?: string): StructuredError {
  return createError("invalid_frontmatter", "Missing or invalid frontmatter", { source });
}

export function invalidYamlError(source?: string): StructuredError {
  return createError("invalid_yaml", "Failed to parse YAML frontmatter", { source });
}

export function missingRequiredFieldError(field: string, source?: string): StructuredError {
  return createError(
    "missing_required_field",
    `Missing required field: ${field}`,
    { source, field }
  );
}

export function invalidFieldTypeError(
  field: string,
  expected: string,
  actual: unknown,
  source?: string
): StructuredError {
  const actualType = Array.isArray(actual) ? "array" : typeof actual;
  return createError(
    "invalid_field_type",
    `Field "${field}" expected ${expected}, got ${actualType}`,
    { source, field }
  );
}

export function emptyBodyError(source?: string): StructuredError {
  return createError("empty_body", "Agent body (system prompt) cannot be empty", { source });
}

export function invalidIdError(id: string, source?: string): StructuredError {
  return createError("invalid_id", `Invalid agent ID: "${id}"`, { source });
}

export function duplicateIdError(id: string, source?: string): StructuredError {
  return createError("duplicate_id", `Duplicate agent ID: "${id}"`, { source });
}
