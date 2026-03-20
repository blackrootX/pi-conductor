// src/types.ts - Shared types for Phase 2 AgentRegistry

import type { AgentSource, StructuredError } from "./errors";
import type { AgentSpec } from "./normalizer";

// ============================================================================
// Resolution Query Types
// ============================================================================

export interface ResolutionQuery {
  /** Find agent by exact ID */
  id?: string;
  /** Find agent by role (e.g., "planner", "coder", "reviewer") */
  role?: string;
  /** Find agent by capability (e.g., "task-analysis", "review") */
  capability?: string;
}

// ============================================================================
// Resolution Result Types
// ============================================================================

export interface ResolutionSuccess {
  success: true;
  agent: AgentSpec;
  resolvedBy: "id" | "role" | "capability";
}

export interface ResolutionFailure {
  success: false;
  error: ResolutionError;
}

export type ResolutionResult = ResolutionSuccess | ResolutionFailure;

export interface ResolutionError {
  code: ResolutionErrorCode;
  message: string;
  requested: Partial<ResolutionQuery>;
}

export type ResolutionErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_NOT_FOUND_BY_ROLE"
  | "AGENT_NOT_FOUND_BY_CAPABILITY"
  | "AMBIGUOUS_RESOLUTION"
  | "INVALID_QUERY";

// ============================================================================
// Registry Diagnostic Types
// ============================================================================

export interface RegistryDiagnostic {
  type: "info" | "warning" | "error";
  code: DiagnosticCode;
  message: string;
  agentId?: string;
  filePath?: string;
  details?: Record<string, unknown>;
}

export type DiagnosticCode =
  | "AGENT_LOADED"
  | "AGENT_OVERRIDDEN"
  | "AGENT_DUPLICATE_SOURCE"
  | "AGENT_MISSING_ROLE"
  | "AGENT_MISSING_CAPABILITIES"
  | "RESOLUTION_AMBIGUOUS";

// ============================================================================
// Registry State Types
// ============================================================================

export interface LoadedAgentEntry {
  spec: AgentSpec;
  resolvedBy: "id" | "role" | "capability";
  resolvedAt?: number;
}

export interface RegistryState {
  agents: Map<string, LoadedAgentEntry>;
  errors: StructuredError[];
  overrides: OverrideRecord[];
  duplicates: DuplicateRecord[];
  diagnostics: RegistryDiagnostic[];
  lastLoaded: number | null;
}

export interface OverrideRecord {
  overriddenId: string;
  overriddenSource: AgentSource;
  overridingSource: AgentSource;
  overridingFilePath: string;
}

export interface DuplicateRecord {
  id: string;
  sources: Array<{
    source: AgentSource;
    filePath: string;
  }>;
}

// ============================================================================
// Load Options
// ============================================================================

export interface RegistryLoadOptions {
  cwd?: string;
  includeBuiltIn?: boolean;
  includeUser?: boolean;
  includeProject?: boolean;
  /** Override the project agents directory */
  projectAgentsPath?: string;
  /** Override the user agents directory */
  userAgentsPath?: string;
  /** Override the built-in agents directory */
  builtInAgentsPath?: string;
  /** Custom agent source resolver */
  sourceResolver?: (filePath: string) => AgentSource;
}

// ============================================================================
// Registry Events (for extensibility)
// ============================================================================

export interface RegistryEventMap {
  "agent:loaded": { agent: AgentSpec };
  "agent:overridden": { overridden: AgentSpec; overriding: AgentSpec };
  "agent:duplicate-detected": { id: string; sources: DuplicateRecord["sources"] };
  "error:parsing": { error: StructuredError };
  "diagnostic:warning": { diagnostic: RegistryDiagnostic };
}

// ============================================================================
// Re-export common types
// ============================================================================

export type { AgentSpec, AgentSource, StructuredError };
