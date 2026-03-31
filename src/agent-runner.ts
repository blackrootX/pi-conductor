import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, Model, TextContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentSource } from "./agents.js";
import type { UsageStats } from "./workflow-runtime.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONDUCTOR_EXTENSIONS_DIR = path.join(PACKAGE_ROOT, "extensions");
const CONDUCTOR_EXTENSION_ENTRY_PATHS = new Set([
  path.join(PACKAGE_ROOT, "src", "index.ts"),
  path.join(PACKAGE_ROOT, "src", "index.js"),
]);

export interface SharedSessionResources {
  agentDir: string;
  settingsManager: SettingsManager;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export interface AgentRunOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  defaultModel?: string;
  signal?: AbortSignal;
  onUpdate?: (result: AgentRunResult) => void;
  sharedResources?: SharedSessionResources;
  systemPromptOverride?: string;
  toolsOverride?: string[];
}

export interface AgentRunResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  task: string;
  exitCode: number;
  elapsedMs: number;
  lastWork: string;
  messages: Message[];
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function createSharedSessionResources(cwd: string): SharedSessionResources {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  return { agentDir, settingsManager, authStorage, modelRegistry };
}

function makeEmptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function normalizeModelLabel(model?: Model<any>): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function getAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function getPartialAssistantText(message: Extract<Message, { role: "assistant" }>): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function resolveModelLabel(
  modelLabel: string | undefined,
  modelRegistry: ModelRegistry,
): Model<any> | undefined {
  const trimmed = modelLabel?.trim();
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    const provider = trimmed.slice(0, slashIndex).trim();
    const modelId = trimmed.slice(slashIndex + 1).trim();
    return provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
  }
  const exactMatches = modelRegistry
    .getAll()
    .filter((m) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
  return exactMatches.length === 1 ? exactMatches[0] : undefined;
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isConductorExtensionPath(filePath: string): boolean {
  const resolvedPath = path.resolve(filePath);
  return (
    CONDUCTOR_EXTENSION_ENTRY_PATHS.has(resolvedPath) ||
    isInsideDirectory(resolvedPath, CONDUCTOR_EXTENSIONS_DIR)
  );
}

function createToolPolicyExtension(allowedToolNames: string[]): ExtensionFactory {
  return (pi) => {
    const allowed = new Set(allowedToolNames);
    pi.on("before_agent_start", async () => {
      pi.setActiveTools(allowedToolNames);
      return undefined;
    });
    pi.on("tool_call", async (event) => {
      if (allowed.has(event.toolName)) return undefined;
      const allowedList = allowedToolNames.length > 0
        ? allowedToolNames.join(", ")
        : "(no tools allowed)";
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed. Allowed tools: ${allowedList}.`,
      };
    });
  };
}

export async function runAgentSession(options: AgentRunOptions): Promise<AgentRunResult> {
  const resources = options.sharedResources ?? createSharedSessionResources(options.cwd);
  const { agentDir, settingsManager, modelRegistry } = resources;

  const resolvedModelLabel = options.agent.model ?? options.defaultModel;
  const resolvedModel = resolveModelLabel(resolvedModelLabel, modelRegistry);

  if (resolvedModelLabel?.trim() && !resolvedModel) {
    throw new Error(`Unknown model: "${resolvedModelLabel}"`);
  }

  const allowedToolNames = options.toolsOverride ?? options.agent.tools;
  const hasExplicitToolPolicy =
    options.toolsOverride !== undefined || options.agent.tools !== undefined;
  const appendedSystemPrompt =
    (options.systemPromptOverride ?? options.agent.systemPrompt).trim();

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    extensionFactories:
      hasExplicitToolPolicy && allowedToolNames
        ? [createToolPolicyExtension(allowedToolNames)]
        : hasExplicitToolPolicy
          ? [createToolPolicyExtension([])]
          : [],
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (extension) => !isConductorExtensionPath(extension.resolvedPath),
      ),
    }),
    appendSystemPromptOverride: (base) =>
      appendedSystemPrompt ? [...base, appendedSystemPrompt] : base,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: resolvedModel,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager,
  });

  if (hasExplicitToolPolicy) {
    session.setActiveToolsByName(allowedToolNames ?? []);
  }

  const startTime = Date.now();
  const currentResult: AgentRunResult = {
    agent: options.agent.name,
    agentSource: options.agent.source,
    task: options.task,
    exitCode: 0,
    elapsedMs: 0,
    lastWork: "",
    messages: [],
    usage: makeEmptyUsage(),
    model: resolvedModelLabel ?? normalizeModelLabel(session.model),
  };

  let activeAssistantText = "";

  const emitUpdate = () => {
    currentResult.elapsedMs = Date.now() - startTime;
    currentResult.lastWork = activeAssistantText || getAssistantText(currentResult.messages);
    options.onUpdate?.({ ...currentResult, messages: [...currentResult.messages] });
  };

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        if (event.message.role !== "assistant") return;
        activeAssistantText = getPartialAssistantText(event.message);
        emitUpdate();
        return;
      }
      case "message_end": {
        if (event.message.role !== "assistant" && event.message.role !== "toolResult") return;
        currentResult.messages.push(event.message);
        if (event.message.role === "assistant") {
          activeAssistantText = "";
          currentResult.usage.turns++;
          currentResult.usage.input += event.message.usage.input || 0;
          currentResult.usage.output += event.message.usage.output || 0;
          currentResult.usage.cacheRead += event.message.usage.cacheRead || 0;
          currentResult.usage.cacheWrite += event.message.usage.cacheWrite || 0;
          currentResult.usage.cost += event.message.usage.cost?.total || 0;
          currentResult.usage.contextTokens = event.message.usage.totalTokens || 0;
          currentResult.model =
            currentResult.model ?? `${event.message.provider}/${event.message.model}`;
          currentResult.stopReason = event.message.stopReason;
          currentResult.errorMessage = event.message.errorMessage;
        }
        emitUpdate();
        return;
      }
      default:
        return;
    }
  });

  const interval = options.onUpdate ? setInterval(() => emitUpdate(), 1000) : undefined;

  let wasAborted = false;
  const abortHandler = () => {
    wasAborted = true;
    void session.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    if (wasAborted) {
      currentResult.exitCode = 1;
      currentResult.stopReason = "aborted";
      currentResult.errorMessage = "Agent session was aborted.";
      currentResult.elapsedMs = Date.now() - startTime;
      return currentResult;
    }

    await session.prompt(options.task, { source: "extension" });
    currentResult.elapsedMs = Date.now() - startTime;
    currentResult.lastWork = activeAssistantText || getAssistantText(currentResult.messages);
    currentResult.exitCode =
      currentResult.stopReason === "error" || currentResult.stopReason === "aborted" ? 1 : 0;
    if (wasAborted && currentResult.stopReason !== "aborted") {
      currentResult.stopReason = "aborted";
      currentResult.errorMessage = "Agent session was aborted.";
      currentResult.exitCode = 1;
    }
    return currentResult;
  } finally {
    if (interval) clearInterval(interval);
    unsubscribe();
    if (options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}
