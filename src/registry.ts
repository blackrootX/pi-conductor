// src/registry.ts - AgentRegistry class for Phase 2

import type {
  AgentSpec,
  AgentSource,
  StructuredError,
  ResolutionQuery,
  ResolutionResult,
  ResolutionError,
  ResolutionErrorCode,
  RegistryDiagnostic,
  RegistryLoadOptions,
  RegistryState,
  LoadedAgentEntry,
  OverrideRecord,
  DuplicateRecord,
  DiagnosticCode,
  ResolutionOptions,
} from "./types";

import { duplicateIdError } from "./errors";
import {
  discoverAgents,
  type DiscoveredFile,
} from "./discovery";
import { loadAgentFile } from "./index";

// ============================================================================
// Source Precedence
// ============================================================================

const SOURCE_PRECEDENCE: readonly AgentSource[] = ["project", "user", "built-in"];

function getSourcePrecedence(source: AgentSource): number {
  return SOURCE_PRECEDENCE.indexOf(source);
}

function getPriorityScore(agent: AgentSpec): number {
  return agent.priority ?? 0;
}

function compareAgentsDeterministically(a: AgentSpec, b: AgentSpec): number {
  const precedenceDiff = getSourcePrecedence(a.source) - getSourcePrecedence(b.source);
  if (precedenceDiff !== 0) return precedenceDiff;

  const priorityDiff = getPriorityScore(b) - getPriorityScore(a);
  if (priorityDiff !== 0) return priorityDiff;

  const nameDiff = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (nameDiff !== 0) return nameDiff;

  return (a.filePath || "").localeCompare(b.filePath || "");
}

function resolveBestMatch(matches: AgentSpec[]): AgentSpec | undefined {
  return [...matches].sort(compareAgentsDeterministically)[0];
}

// ============================================================================
// Registry Implementation
// ============================================================================

export class AgentRegistry {
  private _agents: Map<string, LoadedAgentEntry> = new Map();
  private _errors: StructuredError[] = [];
  private _overrides: OverrideRecord[] = [];
  private _duplicates: DuplicateRecord[] = [];
  private _diagnostics: RegistryDiagnostic[] = [];
  private _lastLoaded: number | null = null;
  private _loaded = false;
  private _loadingPromise: Promise<void> | null = null;
  private _options: RegistryLoadOptions = {};

  constructor(options: RegistryLoadOptions = {}) {
    this._options = { ...options };
  }

  // ============================================================================
  // Public API: Loading
  // ============================================================================

  /**
   * Load all agents from configured sources.
   * This is the main initialization method.
   * Uses _loadingPromise to prevent race conditions when multiple callers
   * invoke loadAll() or ensureLoaded() concurrently.
   */
  async loadAll(): Promise<void> {
    // Don't reload if already loaded
    if (this._loaded && this._agents.size > 0) {
      return;
    }

    // If a load is already in-flight, wait for it instead of starting a new one
    if (this._loadingPromise) {
      await this._loadingPromise;
      return;
    }

    // Start the loading process and store the promise
    this._loadingPromise = this._doLoad();

    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  /**
   * Internal method that performs the actual loading work.
   * Always called via loadAll() which manages the _loadingPromise.
   */
  private async _doLoad(): Promise<void> {
    this.reset();
    this._loaded = true;
    this._lastLoaded = Date.now();

    // Discover agent files
    const discoveryResult = await discoverAgents(this._options);
    this._errors.push(...discoveryResult.errors);

    // Track files by ID to detect cross-source duplicates
    const filesById = new Map<string, DiscoveredFile[]>();

    for (const file of discoveryResult.files) {
      const existing = filesById.get(file.id) || [];
      existing.push(file);
      filesById.set(file.id, existing);
    }

    // Detect cross-source duplicates and overrides
    for (const [id, files] of filesById) {
      if (files.length > 1) {
        // Sort by precedence (highest first)
        const sorted = [...files].sort(
          (a, b) => getSourcePrecedence(a.source) - getSourcePrecedence(b.source)
        );

        const winner = sorted[0];
        const losers = sorted.slice(1);

        // Record duplicate
        this._duplicates.push({
          id,
          sources: files.map((f) => ({ source: f.source, filePath: f.filePath })),
        });

        // Record overrides
        for (const loser of losers) {
          this._overrides.push({
            overriddenId: id,
            overriddenSource: loser.source,
            overridingSource: winner.source,
            overridingFilePath: winner.filePath,
          });

          this._diagnostics.push({
            type: "warning",
            code: "AGENT_OVERRIDDEN",
            message: `Agent "${id}" from ${loser.source} overridden by ${winner.source}`,
            agentId: id,
            filePath: loser.filePath,
            details: {
              overriddenSource: loser.source,
              overridingSource: winner.source,
            },
          });
        }
      }
    }

    // Load agents in precedence order (lowest precedence first so higher precedence wins)
    const reversedSources = [...SOURCE_PRECEDENCE].reverse();

    for (const source of reversedSources) {
      const files = discoveryResult.files.filter((f) => f.source === source);

      for (const file of files) {
        // Check if this file is a loser in a duplicate situation
        const isOverridden = this._overrides.some(
          (o) => o.overriddenId === file.id && o.overriddenSource === file.source
        );

        if (isOverridden) {
          continue; // Skip this file, a higher precedence one exists
        }

        const result = await loadAgentFile(file.filePath, file.source);

        if (result.errors.length > 0) {
          this._errors.push(...result.errors);
          continue;
        }

        if (result.agent) {
          // Check if we already have this agent (from higher precedence source)
          const existing = this._agents.get(file.id);

          if (existing) {
            // Shouldn't happen if we're processing in reverse precedence order,
            // but double-check
            const existingPrecedence = getSourcePrecedence(existing.spec.source);
            const newPrecedence = getSourcePrecedence(file.source);

            if (newPrecedence < existingPrecedence) {
              // New one has higher precedence, replace
              this._agents.set(file.id, {
                spec: result.agent,
                resolvedBy: "id",
              });
            }
          } else {
            // First time seeing this agent ID
            this._agents.set(file.id, {
              spec: result.agent,
              resolvedBy: "id",
            });

            this._diagnostics.push({
              type: "info",
              code: "AGENT_LOADED",
              message: `Agent "${file.id}" loaded from ${file.source}`,
              agentId: file.id,
              filePath: file.filePath,
            });

            // Check for missing metadata
            if (!result.agent.role) {
              this._diagnostics.push({
                type: "warning",
                code: "AGENT_MISSING_ROLE",
                message: `Agent "${file.id}" is missing a role definition`,
                agentId: file.id,
                filePath: file.filePath,
              });
            }

            if (!result.agent.capabilities || result.agent.capabilities.length === 0) {
              this._diagnostics.push({
                type: "warning",
                code: "AGENT_MISSING_CAPABILITIES",
                message: `Agent "${file.id}" has no capabilities defined`,
                agentId: file.id,
                filePath: file.filePath,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Ensure registry is loaded.
   * Awaits any in-flight loading operation before returning.
   */
  private async ensureLoaded(): Promise<void> {
    // If loading is in progress, wait for it
    if (this._loadingPromise) {
      await this._loadingPromise;
      return;
    }

    // If already loaded, return immediately
    if (this._loaded) {
      return;
    }

    // Otherwise, start loading
    await this.loadAll();
  }

  // ============================================================================
  // Public API: List Methods
  // ============================================================================

  /**
   * Get all loaded agents.
   */
  async listAgents(): Promise<AgentSpec[]> {
    await this.ensureLoaded();
    return Array.from(this._agents.values()).map((entry) => entry.spec);
  }

  /**
   * Get all errors encountered during loading.
   */
  async listErrors(): Promise<StructuredError[]> {
    await this.ensureLoaded();
    return [...this._errors];
  }

  /**
   * Get all diagnostics.
   */
  async listDiagnostics(): Promise<RegistryDiagnostic[]> {
    await this.ensureLoaded();
    return [...this._diagnostics];
  }

  /**
   * Get the full registry state.
   */
  async getState(): Promise<RegistryState> {
    await this.ensureLoaded();
    return {
      agents: new Map(this._agents),
      errors: [...this._errors],
      overrides: [...this._overrides],
      duplicates: [...this._duplicates],
      diagnostics: [...this._diagnostics],
      lastLoaded: this._lastLoaded,
    };
  }

  /**
   * Get all overrides that occurred during loading.
   */
  async listOverrides(): Promise<OverrideRecord[]> {
    await this.ensureLoaded();
    return [...this._overrides];
  }

  /**
   * Get all duplicates detected during loading.
   */
  async listDuplicates(): Promise<DuplicateRecord[]> {
    await this.ensureLoaded();
    return [...this._duplicates];
  }

  // ============================================================================
  // Public API: Find/Resolve Methods
  // ============================================================================

  /**
   * Find a single agent by ID.
   */
  async findById(id: string): Promise<AgentSpec | undefined> {
    await this.ensureLoaded();
    const entry = this._agents.get(id);
    return entry?.spec;
  }

  /**
   * Resolve an agent by role.
   * By default, returns an ambiguity result if multiple agents match.
   * Use options.allowAmbiguous = true to auto-select the best match.
   */
  async resolveByRole(
    role: string,
    options?: ResolutionOptions
  ): Promise<ResolutionResult> {
    await this.ensureLoaded();

    const matches: AgentSpec[] = [];

    for (const [, entry] of this._agents) {
      if (entry.spec.role?.toLowerCase() === role.toLowerCase()) {
        matches.push(entry.spec);
      }
    }

    if (matches.length === 0) {
      return {
        success: false,
        ambiguous: undefined,
        error: createResolutionError("AGENT_NOT_FOUND_BY_ROLE", {
          role,
        }),
      };
    }

    // Filter by preferred source if specified
    let candidates = matches;
    if (options?.preferSource) {
      const preferred = matches.filter((m) => m.source === options.preferSource);
      if (preferred.length > 0) {
        candidates = preferred;
      }
    }

    // If multiple candidates remain and we don't allow ambiguity, return ambiguity result
    if (candidates.length > 1 && !options?.allowAmbiguous) {
      return this._createAmbiguousResult(candidates, { role });
    }

    // Auto-select if allowed and needed
    const winner = resolveBestMatch(candidates)!;

    return {
      success: true,
      agent: winner,
      resolvedBy: "role",
    };
  }

  /**
   * Resolve an agent by capability.
   * By default, returns an ambiguity result if multiple agents match.
   * Use options.allowAmbiguous = true to auto-select the best match.
   */
  async resolveByCapability(
    capability: string,
    options?: ResolutionOptions
  ): Promise<ResolutionResult> {
    await this.ensureLoaded();

    const matches: AgentSpec[] = [];

    for (const [, entry] of this._agents) {
      const caps = entry.spec.capabilities || [];
      if (caps.some((c) => c.toLowerCase() === capability.toLowerCase())) {
        matches.push(entry.spec);
      }
    }

    if (matches.length === 0) {
      return {
        success: false,
        ambiguous: undefined,
        error: createResolutionError("AGENT_NOT_FOUND_BY_CAPABILITY", {
          capability,
        }),
      };
    }

    // Filter by preferred source if specified
    let candidates = matches;
    if (options?.preferSource) {
      const preferred = matches.filter((m) => m.source === options.preferSource);
      if (preferred.length > 0) {
        candidates = preferred;
      }
    }

    // If multiple candidates remain and we don't allow ambiguity, return ambiguity result
    if (candidates.length > 1 && !options?.allowAmbiguous) {
      return this._createAmbiguousResult(candidates, { capability });
    }

    // Auto-select if allowed and needed
    const winner = resolveBestMatch(candidates)!;

    return {
      success: true,
      agent: winner,
      resolvedBy: "capability",
    };
  }

  /**
   * Create an ambiguity result with all matching agents.
   */
  private _createAmbiguousResult(
    matches: AgentSpec[],
    requested: Partial<ResolutionQuery>
  ): ResolutionResult {
    const agentIds = matches.map((m) => m.id);

    // Add diagnostic for the ambiguity
    this._diagnostics.push({
      type: "warning",
      code: "RESOLUTION_AMBIGUOUS",
      message: `Ambiguous resolution: ${matches.length} agents match the query: ${agentIds.join(", ")}`,
      agentIds,
      details: {
        matchCount: matches.length,
        matchIds: agentIds,
      },
    });

    return {
      success: false,
      ambiguous: true,
      matches,
      error: createResolutionError("AMBIGUOUS_RESOLUTION", requested),
    };
  }

  /**
   * Unified resolution by ID, role, or capability.
   * Resolution order: id > role > capability
   * By default, returns ambiguity if multiple agents match role/capability criteria.
   * Use query.options.allowAmbiguous = true to auto-select the best match.
   */
  async resolve(query: ResolutionQuery): Promise<ResolutionResult> {
    await this.ensureLoaded();

    // Validate query
    if (!query.id && !query.role && !query.capability) {
      return {
        success: false,
        ambiguous: undefined,
        error: createResolutionError("INVALID_QUERY", {
          ...query,
        }),
      };
    }

    // Try ID first (ID lookups are always unambiguous)
    if (query.id) {
      const agent = this._agents.get(query.id);
      if (agent) {
        return {
          success: true,
          agent: agent.spec,
          resolvedBy: "id",
        };
      }
    }

    // Try role
    if (query.role) {
      const roleResult = await this.resolveByRole(query.role, query.options);
      // Return immediately on success or ambiguity (don't fall through to capability)
      if (roleResult.success) {
        return roleResult;
      }
      // Only continue if the failure is "not found", not ambiguity
      if ("ambiguous" in roleResult && roleResult.ambiguous) {
        return roleResult;
      }
    }

    // Try capability
    if (query.capability) {
      const capResult = await this.resolveByCapability(query.capability, query.options);
      if (capResult.success) {
        return capResult;
      }
      // Return ambiguity if present (don't fall through to "not found")
      if ("ambiguous" in capResult && capResult.ambiguous) {
        return capResult;
      }
    }

    // Not found
    return {
      success: false,
      ambiguous: undefined,
      error: createResolutionError("AGENT_NOT_FOUND", {
        ...query,
      }),
    };
  }

  /**
   * Resolve by role with explicit tiebreaker control.
   * This method always selects a single winner using the specified tiebreaker.
   * For ambiguous resolution without auto-selection, use resolveByRole().
   */
  async resolveByRoleWithTiebreaker(
    role: string,
    tiebreaker?: "priority" | "name" | "filePath"
  ): Promise<ResolutionResult> {
    await this.ensureLoaded();

    const matches: AgentSpec[] = [];

    for (const [, entry] of this._agents) {
      if (entry.spec.role?.toLowerCase() === role.toLowerCase()) {
        matches.push(entry.spec);
      }
    }

    if (matches.length === 0) {
      return {
        success: false,
        ambiguous: undefined,
        error: createResolutionError("AGENT_NOT_FOUND_BY_ROLE", {
          role,
        }),
      };
    }

    // If we have multiple matches, log that we're using tiebreaker to resolve
    if (matches.length > 1) {
      this._diagnostics.push({
        type: "info",
        code: "RESOLUTION_AMBIGUITY_RESOLVED",
        message: `Ambiguous resolution for role "${role}" resolved using ${tiebreaker || "default"} tiebreaker`,
        agentIds: matches.map((m) => m.id),
        details: {
          matchCount: matches.length,
          tiebreaker,
        },
      });
    }

    const winner = [...matches].sort((a, b) => {
      const precedenceDiff = getSourcePrecedence(a.source) - getSourcePrecedence(b.source);
      if (precedenceDiff !== 0) return precedenceDiff;

      switch (tiebreaker) {
        case "priority":
          return getPriorityScore(b) - getPriorityScore(a);
        case "name":
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        case "filePath":
          return (a.filePath || "").localeCompare(b.filePath || "");
        default:
          return compareAgentsDeterministically(a, b);
      }
    })[0]!;

    return {
      success: true,
      agent: winner,
      resolvedBy: "role",
    };
  }

  // ============================================================================
  // Public API: Query Methods
  // ============================================================================

  /**
   * Check if an agent with the given ID exists.
   */
  async hasAgent(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return this._agents.has(id);
  }

  /**
   * Get agents by source.
   */
  async getAgentsBySource(source: AgentSource): Promise<AgentSpec[]> {
    await this.ensureLoaded();
    return Array.from(this._agents.values())
      .filter((entry) => entry.spec.source === source)
      .map((entry) => entry.spec);
  }

  /**
   * Get agents by tag.
   */
  async getAgentsByTag(tag: string): Promise<AgentSpec[]> {
    await this.ensureLoaded();
    return Array.from(this._agents.values())
      .filter((entry) => entry.spec.tags?.includes(tag))
      .map((entry) => entry.spec);
  }

  /**
   * Get all unique roles in the registry.
   */
  async listRoles(): Promise<string[]> {
    await this.ensureLoaded();
    const roles = new Set<string>();
    for (const [id, entry] of this._agents) {
      if (entry.spec.role) {
        roles.add(entry.spec.role);
      }
    }
    return Array.from(roles);
  }

  /**
   * Get all unique capabilities in the registry.
   */
  async listCapabilities(): Promise<string[]> {
    await this.ensureLoaded();
    const caps = new Set<string>();
    for (const [id, entry] of this._agents) {
      for (const cap of entry.spec.capabilities || []) {
        caps.add(cap);
      }
    }
    return Array.from(caps);
  }

  /**
   * Get all unique tags in the registry.
   */
  async listTags(): Promise<string[]> {
    await this.ensureLoaded();
    const tags = new Set<string>();
    for (const [id, entry] of this._agents) {
      for (const tag of entry.spec.tags || []) {
        tags.add(tag);
      }
    }
    return Array.from(tags);
  }

  // ============================================================================
  // Public API: Utility Methods
  // ============================================================================

  /**
   * Get the count of loaded agents.
   */
  async count(): Promise<number> {
    await this.ensureLoaded();
    return this._agents.size;
  }

  /**
   * Check if the registry has been loaded.
   */
  isLoaded(): boolean {
    return this._loaded;
  }

  /**
   * Get the timestamp of the last load.
   */
  getLastLoaded(): number | null {
    return this._lastLoaded;
  }

  /**
   * Reset the registry state.
   */
  reset(): void {
    this._agents.clear();
    this._errors = [];
    this._overrides = [];
    this._duplicates = [];
    this._diagnostics = [];
    this._lastLoaded = null;
    this._loaded = false;
  }

  /**
   * Update options and reload.
   */
  async reload(options?: Partial<RegistryLoadOptions>): Promise<void> {
    if (options) {
      this._options = { ...this._options, ...options };
    }
    this.reset();
    await this.loadAll();
  }

  /**
   * Get a summary of the registry state.
   */
  async summarize(): Promise<string> {
    await this.ensureLoaded();

    const lines: string[] = [];
    lines.push("=== Agent Registry Summary ===");
    lines.push(`Total agents: ${this._agents.size}`);
    lines.push(`Errors: ${this._errors.length}`);
    lines.push(`Overrides: ${this._overrides.length}`);
    lines.push(`Duplicates: ${this._duplicates.length}`);
    lines.push(`Diagnostics: ${this._diagnostics.length}`);
    lines.push(`Last loaded: ${this._lastLoaded ? new Date(this._lastLoaded).toISOString() : "never"}`);
    lines.push("");

    // Group by source
    const bySource: Record<AgentSource, number> = {
      project: 0,
      user: 0,
      "built-in": 0,
    };

    for (const entry of this._agents.values()) {
      bySource[entry.spec.source]++;
    }

    lines.push("Agents by source:");
    for (const [source, count] of Object.entries(bySource)) {
      lines.push(`  ${source}: ${count}`);
    }

    lines.push("");
    lines.push("All agents:");
    for (const [id, entry] of this._agents) {
      const source = entry.spec.source.padEnd(10);
      const role = (entry.spec.role || "-").padEnd(15);
      lines.push(`  [${source}] ${id.padEnd(30)} role: ${role} name: "${entry.spec.name}"`);
    }

    return lines.join("\n");
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createResolutionError(
  code: ResolutionErrorCode,
  requested: Partial<ResolutionQuery>
): ResolutionError {
  let message: string;

  switch (code) {
    case "AGENT_NOT_FOUND":
      message = `No agent found for query: ${JSON.stringify(requested)}`;
      break;
    case "AGENT_NOT_FOUND_BY_ROLE":
      message = `No agent found for role "${requested.role}"`;
      break;
    case "AGENT_NOT_FOUND_BY_CAPABILITY":
      message = `No agent found for capability "${requested.capability}"`;
      break;
    case "AMBIGUOUS_RESOLUTION":
      message = "Multiple agents match the query, resolution is ambiguous";
      break;
    case "INVALID_QUERY":
      message = "Invalid resolution query: must specify at least one of id, role, or capability";
      break;
    default:
      message = "Unknown resolution error";
  }

  return {
    code,
    message,
    requested,
  };
}

// ============================================================================
// Factory Functions (convenience)
// ============================================================================

/**
 * Create a new registry with default options and load it.
 */
export async function createRegistry(options?: RegistryLoadOptions): Promise<AgentRegistry> {
  const registry = new AgentRegistry(options);
  await registry.loadAll();
  return registry;
}

/**
 * Create a registry with built-in, user, and project agents.
 */
export async function createDefaultRegistry(cwd?: string): Promise<AgentRegistry> {
  return createRegistry({
    cwd: cwd || process.cwd(),
    includeBuiltIn: true,
    includeUser: true,
    includeProject: true,
  });
}

// ============================================================================
// Export types for convenience
// ============================================================================

export type {
  RegistryLoadOptions,
  RegistryState,
} from "./types";

export type { DiscoveredFile } from "./discovery";
