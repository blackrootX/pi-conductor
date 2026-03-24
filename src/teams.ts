import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";

export const DEFAULT_TEAM_NAME = "plan-build-parallel";

export type TeamSource = "built-in" | "global" | "project";
export type TeamPhaseKind = "parallel" | "sequential";

export interface TeamPhaseConfig {
  kind: TeamPhaseKind;
  agentNames: string[];
}

export interface TeamConfig {
  name: string;
  phases: TeamPhaseConfig[];
  source: TeamSource;
  filePath?: string;
}

export interface TeamDiscoveryResult {
  teams: TeamConfig[];
  projectTeamFile: string | null;
  globalTeamFile: string;
  warnings: string[];
}

const BUILT_IN_TEAMS: TeamConfig[] = [
  {
    name: DEFAULT_TEAM_NAME,
    phases: [
      { kind: "parallel", agentNames: ["plan", "plan"] },
      { kind: "sequential", agentNames: ["build"] },
    ],
    source: "built-in",
  },
];

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findNearestProjectTeamFile(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "team.yaml");
    if (fileExists(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function formatTeamWarning(filePath: string, message: string): string {
  return `${path.relative(process.cwd(), filePath) || filePath}: ${message}`;
}

function parsePhaseConfig(value: unknown): TeamPhaseConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const rawPhase = value as Record<string, unknown>;
  const kinds = (["parallel", "sequential"] as const).filter(
    (kind) => kind in rawPhase,
  );
  if (kinds.length !== 1) return undefined;

  const kind = kinds[0];
  const members = rawPhase[kind];
  if (!Array.isArray(members)) return undefined;

  const agentNames = members.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  if (agentNames.length !== members.length || agentNames.length === 0) return undefined;

  return { kind, agentNames };
}

function loadTeamsFromFile(
  filePath: string,
  source: Exclude<TeamSource, "built-in">,
): { teams: TeamConfig[]; warnings: string[] } {
  if (!fileExists(filePath)) return { teams: [], warnings: [] };

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return {
      teams: [],
      warnings: [formatTeamWarning(filePath, "could not read file; skipping teams from this file.")],
    };
  }

  let data: unknown;
  try {
    data = parseYaml(content);
  } catch {
    return {
      teams: [],
      warnings: [formatTeamWarning(filePath, "YAML parse failed; skipping teams from this file.")],
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      teams: [],
      warnings: [formatTeamWarning(filePath, "expected a YAML mapping at the file root; skipping teams from this file.")],
    };
  }

  const warnings: string[] = [];
  const teams: TeamConfig[] = [];

  for (const [name, value] of Object.entries(data)) {
    if (typeof name !== "string" || name.trim().length === 0) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warnings.push(
        formatTeamWarning(filePath, `team "${name}" is invalid: expected a mapping with a "phases" list.`),
      );
      continue;
    }

    const rawTeam = value as Record<string, unknown>;
    const phasesValue = rawTeam.phases;
    if (!Array.isArray(phasesValue)) {
      warnings.push(
        formatTeamWarning(filePath, `team "${name}" is invalid: "phases" must be a list.`),
      );
      continue;
    }

    const phases: TeamPhaseConfig[] = [];
    let isValid = true;
    for (const phase of phasesValue) {
      const parsed = parsePhaseConfig(phase);
      if (!parsed) {
        warnings.push(
          formatTeamWarning(
            filePath,
            `team "${name}" is invalid: every phase must contain exactly one of "parallel" or "sequential" with a non-empty string list.`,
          ),
        );
        isValid = false;
        break;
      }
      phases.push(parsed);
    }

    if (!isValid || phases.length === 0) continue;

    teams.push({
      name,
      phases,
      source,
      filePath,
    });
  }

  return { teams, warnings };
}

export function discoverTeams(cwd: string): TeamDiscoveryResult {
  const globalTeamFile = path.join(getAgentDir(), "team.yaml");
  const projectTeamFile = findNearestProjectTeamFile(cwd);
  const globalResult = loadTeamsFromFile(globalTeamFile, "global");
  const projectResult = projectTeamFile
    ? loadTeamsFromFile(projectTeamFile, "project")
    : { teams: [], warnings: [] };

  const teamMap = new Map<string, TeamConfig>();
  for (const team of BUILT_IN_TEAMS) teamMap.set(team.name, team);
  for (const team of globalResult.teams) teamMap.set(team.name, team);
  for (const team of projectResult.teams) teamMap.set(team.name, team);

  return {
    teams: Array.from(teamMap.values()),
    projectTeamFile,
    globalTeamFile,
    warnings: [...globalResult.warnings, ...projectResult.warnings],
  };
}
