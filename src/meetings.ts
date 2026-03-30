import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";

export type MeetingSource = "built-in" | "global" | "project";
export type MeetingMode = "execute" | "refine" | "debate";
export type MeetingOutputTarget = "file" | "session";

export type MeetingParticipantSpec =
  | string
  | { cli: "codex" | "opencode"; model?: string; reasoning?: string };

export interface MeetingExecuteConfig {
  name: string;
  mode: "execute";
  phases: Array<{ kind: "parallel" | "sequential"; agentNames: string[] }>;
  source: MeetingSource;
  filePath?: string;
}

export interface MeetingRefineConfig {
  name: string;
  mode: "refine";
  rounds: number;
  reviewer: MeetingParticipantSpec;
  fixer: MeetingParticipantSpec;
  output: MeetingOutputTarget;
  source: MeetingSource;
  filePath?: string;
}

export interface MeetingDebateParticipant {
  role: string;
  agent: MeetingParticipantSpec;
}

export interface MeetingDebateConfig {
  name: string;
  mode: "debate";
  rounds: number;
  participants: MeetingDebateParticipant[];
  output: MeetingOutputTarget;
  source: MeetingSource;
  filePath?: string;
}

export type MeetingConfig = MeetingExecuteConfig | MeetingRefineConfig | MeetingDebateConfig;

export interface MeetingDiscoveryResult {
  meetings: MeetingConfig[];
  projectMeetingFile: string | null;
  globalMeetingFile: string;
  warnings: string[];
}

export const DEFAULT_MEETING_NAME = "plan-build-parallel";

const BUILT_IN_MEETINGS: MeetingConfig[] = [
  {
    name: "plan-build-parallel",
    mode: "execute",
    phases: [
      { kind: "parallel", agentNames: ["plan", "plan"] },
      { kind: "sequential", agentNames: ["build"] },
    ],
    source: "built-in",
  },
  {
    name: "quick-critique",
    mode: "refine",
    rounds: 3,
    reviewer: "plan",
    fixer: "build",
    output: "session",
    source: "built-in",
  },
  {
    name: "proposal-review",
    mode: "refine",
    rounds: 3,
    reviewer: { cli: "codex", reasoning: "xhigh" },
    fixer: { cli: "opencode" },
    output: "file",
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

function formatWarning(filePath: string, message: string): string {
  return `${path.relative(process.cwd(), filePath) || filePath}: ${message}`;
}

function findNearestProjectMeetingFile(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "meeting.yaml");
    if (fileExists(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function parseParticipantSpec(value: unknown, fieldName: string, meetingName: string, filePath: string, warnings: string[]): MeetingParticipantSpec | undefined {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      warnings.push(formatWarning(filePath, `meeting "${meetingName}": "${fieldName}" must not be empty.`));
      return undefined;
    }
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const cli = raw.cli;
    if (cli !== "codex" && cli !== "opencode") {
      warnings.push(formatWarning(filePath, `meeting "${meetingName}": "${fieldName}.cli" must be "codex" or "opencode". Use object form for external CLIs.`));
      return undefined;
    }
    return {
      cli,
      model: typeof raw.model === "string" ? raw.model : undefined,
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
    };
  }
  warnings.push(formatWarning(filePath, `meeting "${meetingName}": "${fieldName}" must be a pi agent name (string) or an external CLI object { cli: "codex"|"opencode" }.`));
  return undefined;
}

function parseMeetingFromRaw(
  name: string,
  value: unknown,
  source: Exclude<MeetingSource, "built-in">,
  filePath: string,
  warnings: string[],
): MeetingConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(formatWarning(filePath, `meeting "${name}" is invalid: expected a mapping.`));
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const mode = raw.mode;

  if (mode === "execute") {
    const phasesValue = raw.phases;
    if (!Array.isArray(phasesValue) || phasesValue.length === 0) {
      warnings.push(formatWarning(filePath, `meeting "${name}" (execute): "phases" must be a non-empty list.`));
      return undefined;
    }
    const phases: MeetingExecuteConfig["phases"] = [];
    for (const phase of phasesValue) {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
        warnings.push(formatWarning(filePath, `meeting "${name}" (execute): each phase must be a mapping with "parallel" or "sequential".`));
        return undefined;
      }
      const rawPhase = phase as Record<string, unknown>;
      const kinds = (["parallel", "sequential"] as const).filter((k) => k in rawPhase);
      if (kinds.length !== 1) {
        warnings.push(formatWarning(filePath, `meeting "${name}" (execute): each phase must have exactly one of "parallel" or "sequential".`));
        return undefined;
      }
      const kind = kinds[0];
      const members = rawPhase[kind];
      if (!Array.isArray(members) || members.length === 0) {
        warnings.push(formatWarning(filePath, `meeting "${name}" (execute): phase "${kind}" must be a non-empty list of agent names.`));
        return undefined;
      }
      const agentNames = members.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
      if (agentNames.length !== members.length) {
        warnings.push(formatWarning(filePath, `meeting "${name}" (execute): phase "${kind}" members must all be non-empty strings.`));
        return undefined;
      }
      phases.push({ kind, agentNames });
    }
    return { name, mode: "execute", phases, source, filePath };
  }

  if (mode === "refine") {
    const rounds = typeof raw.rounds === "number" ? Math.min(Math.max(1, Math.round(raw.rounds)), 5) : 3;
    const output: MeetingOutputTarget = raw.output === "session" ? "session" : "file";
    const reviewer = parseParticipantSpec(raw.reviewer, "reviewer", name, filePath, warnings);
    const fixer = parseParticipantSpec(raw.fixer, "fixer", name, filePath, warnings);
    if (!reviewer || !fixer) return undefined;
    return { name, mode: "refine", rounds, reviewer, fixer, output, source, filePath };
  }

  if (mode === "debate") {
    const rounds = typeof raw.rounds === "number" ? Math.min(Math.max(1, Math.round(raw.rounds)), 5) : 1;
    const output: MeetingOutputTarget = raw.output === "session" ? "session" : "file";
    const participantsRaw = raw.participants;
    if (!Array.isArray(participantsRaw) || participantsRaw.length < 2) {
      warnings.push(formatWarning(filePath, `meeting "${name}" (debate): "participants" must be a list of at least 2 entries.`));
      return undefined;
    }
    if (participantsRaw.length > 4) {
      warnings.push(formatWarning(filePath, `meeting "${name}" (debate): at most 4 participants allowed.`));
      return undefined;
    }
    const participants: MeetingDebateParticipant[] = [];
    for (const p of participantsRaw) {
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        warnings.push(formatWarning(filePath, `meeting "${name}" (debate): each participant must be a mapping with "role" and "agent".`));
        return undefined;
      }
      const rawP = p as Record<string, unknown>;
      const role = typeof rawP.role === "string" ? rawP.role.trim() : "";
      if (!role) {
        warnings.push(formatWarning(filePath, `meeting "${name}" (debate): each participant must have a non-empty "role".`));
        return undefined;
      }
      const agent = parseParticipantSpec(rawP.agent, "agent", name, filePath, warnings);
      if (!agent) return undefined;
      participants.push({ role, agent });
    }
    return { name, mode: "debate", rounds, participants, output, source, filePath };
  }

  warnings.push(formatWarning(filePath, `meeting "${name}": "mode" must be "execute", "refine", or "debate" (got ${JSON.stringify(mode)}).`));
  return undefined;
}

function loadMeetingsFromFile(
  filePath: string,
  source: Exclude<MeetingSource, "built-in">,
): { meetings: MeetingConfig[]; warnings: string[] } {
  if (!fileExists(filePath)) return { meetings: [], warnings: [] };

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { meetings: [], warnings: [formatWarning(filePath, "could not read file; skipping meetings from this file.")] };
  }

  let data: unknown;
  try {
    data = parseYaml(content);
  } catch {
    return { meetings: [], warnings: [formatWarning(filePath, "YAML parse failed; skipping meetings from this file.")] };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { meetings: [], warnings: [formatWarning(filePath, "expected a YAML mapping at the file root; skipping meetings from this file.")] };
  }

  const warnings: string[] = [];
  const meetings: MeetingConfig[] = [];

  for (const [name, value] of Object.entries(data)) {
    if (typeof name !== "string" || name.trim().length === 0) continue;
    const meeting = parseMeetingFromRaw(name, value, source, filePath, warnings);
    if (meeting) meetings.push(meeting);
  }

  return { meetings, warnings };
}

export function discoverMeetings(cwd: string): MeetingDiscoveryResult {
  const globalMeetingFile = path.join(getAgentDir(), "meeting.yaml");
  const projectMeetingFile = findNearestProjectMeetingFile(cwd);
  const globalResult = loadMeetingsFromFile(globalMeetingFile, "global");
  const projectResult = projectMeetingFile
    ? loadMeetingsFromFile(projectMeetingFile, "project")
    : { meetings: [], warnings: [] };

  const meetingMap = new Map<string, MeetingConfig>();
  for (const meeting of BUILT_IN_MEETINGS) meetingMap.set(meeting.name, meeting);
  for (const meeting of globalResult.meetings) meetingMap.set(meeting.name, meeting);
  for (const meeting of projectResult.meetings) meetingMap.set(meeting.name, meeting);

  return {
    meetings: Array.from(meetingMap.values()),
    projectMeetingFile,
    globalMeetingFile,
    warnings: [...globalResult.warnings, ...projectResult.warnings],
  };
}
