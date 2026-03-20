// src/index.ts - Main entry point for pi-conductor
//
// Phase 1: Parse, normalize, and load agents
// Phase 2: Discover, merge, resolve with AgentRegistry
//
// This file re-exports all public APIs from the package.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Re-export Phase 1 modules
export {
  parseMarkdown,
  extractFrontmatter,
  parseYaml,
} from "./parser";
export type { ParsedAgent } from "./parser";

export {
  normalizeAgent,
  normalizeId,
  isValidId,
  deduplicateStrings,
  detectDuplicateIds,
} from "./normalizer";
export type { AgentSpec, NormalizedAgent, NormalizationResult } from "./normalizer";

export {
  invalidFrontmatterError,
  invalidYamlError,
  missingRequiredFieldError,
  invalidFieldTypeError,
  emptyBodyError,
  invalidIdError,
  duplicateIdError,
} from "./errors";
export type { StructuredError, ErrorCode, AgentSource } from "./errors";

// Re-export Phase 2 types and registry
export {
  AgentRegistry,
  createRegistry,
  createDefaultRegistry,
} from "./registry";
export type {
  RegistryLoadOptions,
  RegistryState,
  DiscoveredFile,
} from "./registry";

export * from "./types";

// Re-export discovery functions
export {
  discoverAgents,
  discoverAgentsBySource,
  findAgentFiles,
  findAgentsMatching,
  detectDuplicateIdsInSource,
  normalizeFileToId,
  getSourcePaths,
} from "./discovery";

// ============================================================================
// Legacy Phase 1 APIs (still available for backward compatibility)
// ============================================================================

import type { AgentSource, StructuredError } from "./errors";
import { invalidIdError, duplicateIdError } from "./errors";
import { parseMarkdown } from "./parser";
import type { AgentSpec } from "./normalizer";
import { normalizeAgent, normalizeId, isValidId } from "./normalizer";

// Source precedence (highest to lowest)
const SOURCE_PRECEDENCE: readonly AgentSource[] = ["project", "user", "built-in"];

export interface AgentFile {
  source: AgentSource;
  filePath: string;
  id: string;
  rawId: string;
}

interface DuplicateSourceGroup {
  id: string;
  files: string[];
}

export interface LoadResult {
  agent?: AgentSpec;
  errors: StructuredError[];
}

/**
 * Load and parse a single agent file.
 */
export async function loadAgentFile(filePath: string, source: AgentSource): Promise<LoadResult> {
  const errors: StructuredError[] = [];

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return { errors: [] }; // File doesn't exist, not an error
    }
    return {
      errors: [{ code: "invalid_yaml", message: `Failed to read file: ${filePath}`, source: filePath }],
    };
  }

  const fileName = path.basename(filePath, ".md");
  const rawId = fileName;

  // Derive and validate ID early
  const id = normalizeId(rawId);
  if (!isValidId(id)) {
    return {
      errors: [invalidIdError(rawId, filePath)],
    };
  }

  // Parse markdown
  const parsed = parseMarkdown(raw, filePath);
  if ("code" in parsed) {
    return { errors: [parsed] };
  }

  // Normalize
  const result = normalizeAgent(parsed, rawId, source, filePath, filePath);

  return {
    agent: result.agent?.spec,
    errors: result.errors,
  };
}

/**
 * Find all agent files in a directory.
 */
async function findAgentFilesLegacy(dirPath: string): Promise<string[]> {
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
 * Get the agent file paths for a specific source.
 */
async function getSourcePathsLegacy(
  cwd: string,
  source: AgentSource,
  basePaths: Record<AgentSource, string>
): Promise<string[]> {
  const basePath = basePaths[source];

  switch (source) {
    case "project":
      return findAgentFilesLegacy(basePath);
    case "user":
      return findAgentFilesLegacy(basePath);
    case "built-in":
      return findAgentFilesLegacy(basePath);
  }
}

function detectDuplicateIdsForSource(filePaths: string[]): DuplicateSourceGroup[] {
  const byId = new Map<string, string[]>();

  for (const filePath of filePaths) {
    const id = normalizeId(path.basename(filePath, ".md"));
    const existing = byId.get(id) || [];
    existing.push(filePath);
    byId.set(id, existing);
  }

  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({ id, files }));
}

export interface LoadAllOptions {
  cwd?: string;
  includeBuiltIn?: boolean;
  includeUser?: boolean;
  includeProject?: boolean;
  // Override base paths for testing
  projectAgentsPath?: string;
  userAgentsPath?: string;
  builtInAgentsPath?: string;
}

export interface LoadAllResult {
  agents: AgentSpec[];
  errors: StructuredError[];
  overrides: Array<{
    overriddenId: string;
    overriddenSource: AgentSource;
    overridingSource: AgentSource;
  }>;
  duplicates: Array<{
    id: string;
    sources: Array<{ source: AgentSource; filePath: string }>;
  }>;
}

/**
 * Load all agents from all sources with precedence handling.
 */
export async function loadAllAgents(options: LoadAllOptions = {}): Promise<LoadAllResult> {
  const {
    cwd = process.cwd(),
    includeBuiltIn = true,
    includeUser = true,
    includeProject = true,
    projectAgentsPath,
    userAgentsPath,
    builtInAgentsPath,
  } = options;

  const errors: StructuredError[] = [];
  const agentMap = new Map<string, AgentSpec>();
  const agentFiles: AgentFile[] = [];

  // Load from each source
  const sources: AgentSource[] = [];
  if (includeProject) sources.push("project");
  if (includeUser) sources.push("user");
  if (includeBuiltIn) sources.push("built-in");

  // Build base paths for getSourcePaths
  const basePaths: Record<AgentSource, string> = {
    project: projectAgentsPath || path.join(cwd, ".pi", "agents"),
    user: userAgentsPath || path.join(os.homedir(), ".pi", "agent", "agents"),
    "built-in": builtInAgentsPath || path.join(__dirname, "..", "agents"),
  };

  for (const source of sources) {
    const filePaths = await getSourcePathsLegacy(cwd, source, basePaths);
    const duplicatesInSource = detectDuplicateIdsForSource(filePaths);
    const blockedIds = new Set(duplicatesInSource.map((duplicate) => duplicate.id));

    for (const duplicate of duplicatesInSource) {
      errors.push(duplicateIdError(duplicate.id, duplicate.files[0]));
    }

    for (const filePath of filePaths) {
      const candidateId = normalizeId(path.basename(filePath, ".md"));
      if (blockedIds.has(candidateId)) {
        continue;
      }

      const result = await loadAgentFile(filePath, source);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.agent) {
        const id = result.agent.id;
        const rawId = path.basename(filePath, ".md");
        agentFiles.push({ source, filePath, id, rawId });

        // Check precedence
        const existingAgent = agentMap.get(id);

        if (!existingAgent) {
          // No existing agent with this ID
          agentMap.set(id, result.agent);
        } else {
          // Check precedence
          const existingPrecedence = SOURCE_PRECEDENCE.indexOf(existingAgent.source);
          const newPrecedence = SOURCE_PRECEDENCE.indexOf(source);

          if (newPrecedence < existingPrecedence) {
            // New agent has higher precedence (lower index)
            agentMap.set(id, result.agent);
          }
          // Otherwise keep existing agent (higher precedence)
        }
      }
    }
  }

  // Build override tracking
  const overrides: LoadAllResult["overrides"] = [];
  const duplicates: LoadAllResult["duplicates"] = [];

  // Detect duplicates across sources
  const byId = new Map<string, Array<{ source: AgentSource; filePath: string }>>();

  for (const file of agentFiles) {
    const existing = byId.get(file.id) || [];
    existing.push({ source: file.source, filePath: file.filePath });
    byId.set(file.id, existing);
  }

  for (const [id, sources_list] of byId) {
    if (sources_list.length > 1) {
      // Multiple sources have this ID
      // Sort by precedence (highest first)
      const sorted = [...sources_list].sort(
        (a, b) => SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source)
      );

      // The winner is the highest precedence
      const winner = sorted[0];
      const losers = sorted.slice(1);

      for (const loser of losers) {
        overrides.push({
          overriddenId: id,
          overriddenSource: loser.source,
          overridingSource: winner.source,
        });
      }

      duplicates.push({ id, sources: sources_list });
    }
  }

  return {
    agents: Array.from(agentMap.values()),
    errors,
    overrides,
    duplicates,
  };
}

/**
 * Find a single agent by name/ID with precedence handling.
 */
export async function findAgent(
  agentId: string,
  options: {
    cwd?: string;
    projectAgentsPath?: string;
    userAgentsPath?: string;
    builtInAgentsPath?: string;
  } = {}
): Promise<LoadResult> {
  const { cwd = process.cwd(), projectAgentsPath, userAgentsPath, builtInAgentsPath } = options;

  const normalizedId = normalizeId(agentId);

  if (!isValidId(normalizedId)) {
    return {
      errors: [invalidIdError(agentId)],
    };
  }

  // Build base paths for getSourcePaths
  const basePaths: Record<AgentSource, string> = {
    project: projectAgentsPath || path.join(cwd, ".pi", "agents"),
    user: userAgentsPath || path.join(os.homedir(), ".pi", "agent", "agents"),
    "built-in": builtInAgentsPath || path.join(__dirname, "..", "agents"),
  };

  // Check sources in precedence order
  for (const source of SOURCE_PRECEDENCE) {
    const paths = await getSourcePathsLegacy(cwd, source, basePaths);

    for (const filePath of paths) {
      const fileId = normalizeId(path.basename(filePath, ".md"));

      if (fileId === normalizedId) {
        return loadAgentFile(filePath, source);
      }
    }
  }

  return { errors: [] }; // Not found, not an error
}

/**
 * Get a summary of all loaded agents for debugging.
 */
export function summarizeAgents(agents: AgentSpec[]): string {
  const lines: string[] = [];

  for (const agent of agents) {
    const source = agent.source.padEnd(10);
    const id = agent.id.padEnd(30);
    lines.push(`[${source}] ${id} "${agent.name}"`);
  }

  return lines.join("\n");
}
