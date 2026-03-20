// src/parser.ts - Parse markdown agent files with YAML frontmatter

import { parseDocument } from "yaml";

import type { StructuredError } from "./errors";
import { invalidFrontmatterError, invalidYamlError, emptyBodyError } from "./errors";

export interface ParsedAgent {
  frontmatter: Record<string, unknown> | null;
  body: string;
  rawFrontmatter: string | null;
}

/**
 * Extract the YAML frontmatter block from markdown content.
 * Frontmatter must be at the very beginning of the file.
 */
export function extractFrontmatter(raw: string): { frontmatter: string | null; content: string } {
  // Match YAML frontmatter: --- ... ---
  // Must start at beginning, handles both \n and \r\n line endings
  const match = raw.match(/^(?:---\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n|$)/);

  if (!match) {
    return { frontmatter: null, content: raw };
  }

  const frontmatter = match[1];
  const content = raw.slice(match[0].length);

  return { frontmatter, content };
}

/**
 * Parse a YAML string into a plain object.
 * Returns null if YAML is empty string.
 * Throws when the YAML is malformed or is not a mapping.
 */
export function parseYaml(yaml: string): Record<string, unknown> | null {
  const trimmed = yaml.trim();

  if (!trimmed) {
    return null;
  }

  const document = parseDocument(trimmed);
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }

  const parsed = document.toJSON();
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }

  return parsed as Record<string, unknown>;
}

/**
 * Parse a markdown file content into frontmatter and body.
 */
export function parseMarkdown(raw: string, source?: string): ParsedAgent | StructuredError {
  const { frontmatter: fmString, content: body } = extractFrontmatter(raw);

  // Check for empty frontmatter
  if (fmString === null) {
    return invalidFrontmatterError(source);
  }

  // Empty frontmatter (just whitespace or empty)
  if (!fmString.trim()) {
    return invalidFrontmatterError(source);
  }

  // Parse YAML
  let frontmatter: Record<string, unknown> | null;
  try {
    frontmatter = parseYaml(fmString);
    if (frontmatter === null) {
      return invalidFrontmatterError(source);
    }
  } catch {
    return invalidYamlError(source);
  }

  // Extract body and trim
  const trimmedBody = body.trim();

  // Body is required (system prompt)
  if (!trimmedBody) {
    return emptyBodyError(source);
  }

  return {
    frontmatter,
    body: trimmedBody,
    rawFrontmatter: fmString,
  };
}
