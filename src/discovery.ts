// src/discovery.ts - Agent file discovery layer for Phase 2

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { AgentSource, StructuredError } from "./errors";
import { duplicateIdError } from "./errors";

export interface DiscoveredFile {
  source: AgentSource;
  filePath: string;
  id: string;
  rawId: string;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  errors: StructuredError[];
}

export interface DiscoveryOptions {
  cwd?: string;
  includeBuiltIn?: boolean;
  includeUser?: boolean;
  includeProject?: boolean;
  projectAgentsPath?: string;
  userAgentsPath?: string;
  builtInAgentsPath?: string;
  /** Custom function to resolve source from file path */
  sourceResolver?: (filePath: string) => AgentSource;
}

/**
 * Get the default path for each agent source.
 */
export function getSourcePaths(
  cwd: string,
  options: DiscoveryOptions
): Record<AgentSource, string> {
  return {
    project: options.projectAgentsPath || path.join(cwd, ".pi", "agents"),
    user: options.userAgentsPath || path.join(os.homedir(), ".pi", "agent", "agents"),
    "built-in": options.builtInAgentsPath || path.join(__dirname, "..", "agents"),
  };
}

/**
 * Find all agent files (.md) in a directory.
 */
export async function findAgentFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dirPath, entry.name));
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Normalize a filename to an agent ID.
 * This is a simplified version that doesn't import normalizer to avoid circular deps.
 */
export function normalizeFileToId(filename: string): string {
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
  return normalizeFileToId(id).length > 0;
}

/**
 * Detect duplicate IDs within a single source folder.
 */
export function detectDuplicateIdsInSource(filePaths: string[]): Array<{ id: string; files: string[] }> {
  const byId = new Map<string, string[]>();

  for (const filePath of filePaths) {
    const id = normalizeFileToId(path.basename(filePath, ".md"));
    const existing = byId.get(id) || [];
    existing.push(filePath);
    byId.set(id, existing);
  }

  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files }));
}

/**
 * Discover all agent files from configured sources.
 */
export async function discoverAgents(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const {
    cwd = process.cwd(),
    includeBuiltIn = true,
    includeUser = true,
    includeProject = true,
  } = options;

  const errors: StructuredError[] = [];
  const allFiles: DiscoveredFile[] = [];

  // Determine which sources to include (in precedence order)
  const sources: AgentSource[] = [];
  if (includeProject) sources.push("project");
  if (includeUser) sources.push("user");
  if (includeBuiltIn) sources.push("built-in");

  // Get base paths for each source
  const basePaths = getSourcePaths(cwd, options);

  // Process each source
  for (const source of sources) {
    const dirPath = basePaths[source];
    const filePaths = await findAgentFiles(dirPath);

    // Detect duplicates within this source
    const duplicates = detectDuplicateIdsInSource(filePaths);

    // Create errors for duplicates (same source = ERROR)
    for (const duplicate of duplicates) {
      errors.push(duplicateIdError(duplicate.id, duplicate.files[0]));
    }

    // Track blocked IDs (duplicates in same source are blocked)
    const blockedIds = new Set(duplicates.map((d) => d.id));

    // Process valid files
    for (const filePath of filePaths) {
      const rawId = path.basename(filePath, ".md");
      const id = normalizeFileToId(rawId);

      // Skip blocked duplicates
      if (blockedIds.has(id)) {
        continue;
      }

      // Validate ID
      if (!isValidId(rawId)) {
        errors.push({
          code: "invalid_id",
          message: `Invalid agent ID from filename: "${rawId}"`,
          source: filePath,
        });
        continue;
      }

      allFiles.push({
        source,
        filePath,
        id,
        rawId,
      });
    }
  }

  return { files: allFiles, errors };
}

/**
 * Get all agent files grouped by source.
 */
export async function discoverAgentsBySource(
  options: DiscoveryOptions = {}
): Promise<Record<AgentSource, DiscoveredFile[]>> {
  const result = await discoverAgents(options);

  const grouped: Record<AgentSource, DiscoveredFile[]> = {
    project: [],
    user: [],
    "built-in": [],
  };

  for (const file of result.files) {
    grouped[file.source].push(file);
  }

  return grouped;
}

/**
 * Find agent files matching a specific pattern.
 */
export async function findAgentsMatching(
  pattern: RegExp,
  options: DiscoveryOptions = {}
): Promise<DiscoveredFile[]> {
  const result = await discoverAgents(options);
  return result.files.filter((file) => pattern.test(file.id) || pattern.test(file.filePath));
}
