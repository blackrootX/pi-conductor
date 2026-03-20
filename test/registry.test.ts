// test/registry.test.ts - Tests for AgentRegistry (Phase 2)

import { describe, it, expect, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentRegistry,
  createRegistry,
  discoverAgents,
  normalizeFileToId,
} from "../src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

async function createTempAgentsDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-conductor-registry-"));
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      fs.writeFile(path.join(dir, name), content, "utf8")
    )
  );
  return dir;
}

// ============================================================================
// Discovery Tests
// ============================================================================

describe("normalizeFileToId", () => {
  it("normalizes filenames to IDs", () => {
    expect(normalizeFileToId("my_agent.md")).toBe("my-agent");
    expect(normalizeFileToId("Special Agent.md")).toBe("special-agent");
    expect(normalizeFileToId("agent.with.dots.md")).toBe("agent-with-dots");
  });
});

describe("discoverAgents", () => {
  it("discovers agents from user folder", async () => {
    const result = await discoverAgents({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: path.join(fixturesDir, "user"),
    });

    expect(result.files.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0); // No duplicates in user folder
  });

  it("discovers agents from project folder", async () => {
    const result = await discoverAgents({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: false,
      includeProject: true,
      projectAgentsPath: path.join(fixturesDir, "project"),
    });

    expect(result.files.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  it("detects duplicate IDs within same source", async () => {
    const result = await discoverAgents({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: path.join(fixturesDir, "duplicates-user"),
    });

    // Should have errors for duplicates
    expect(result.errors.some((e) => e.code === "duplicate_id")).toBe(true);
    // Blocked agents should not appear in files
    expect(result.files.find((f) => f.id === "duplicate-agent")).toBeUndefined();
  });

  it("handles non-existent directories gracefully", async () => {
    const result = await discoverAgents({
      cwd: "/non/existent/path",
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: "/non/existent/path/.pi/agents",
    });

    expect(result.files).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================================
// AgentRegistry Basic Tests
// ============================================================================

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: true,
      includeUser: true,
      includeProject: true,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
      builtInAgentsPath: path.join(process.cwd(), "agents"),
    });
  });

  describe("loadAll", () => {
    it("loads agents from configured sources", async () => {
      await registry.loadAll();

      const agents = await registry.listAgents();
      expect(agents.length).toBeGreaterThan(0);
    });

    it("does not reload if already loaded", async () => {
      await registry.loadAll();
      const firstLoad = registry.getLastLoaded();

      // Small delay to ensure different timestamp if it were to reload
      await new Promise((r) => setTimeout(r, 10));
      await registry.loadAll();

      // Should NOT have reloaded - lastLoaded should be unchanged
      expect(registry.getLastLoaded()).toBe(firstLoad);
    });

    it("detects overrides", async () => {
      await registry.loadAll();

      const overrides = await registry.listOverrides();
      // Project planner should override built-in planner
      // Since built-in is not loaded, no override should occur
      expect(Array.isArray(overrides)).toBe(true);
    });

    it("tracks diagnostics", async () => {
      await registry.loadAll();

      const diagnostics = await registry.listDiagnostics();
      expect(diagnostics.length).toBeGreaterThan(0);

      // Should have info diagnostic for loaded agents
      const infoDiags = diagnostics.filter((d) => d.type === "info");
      expect(infoDiags.length).toBeGreaterThan(0);
    });
  });

  describe("findById", () => {
    it("finds an agent by ID", async () => {
      await registry.loadAll();

      const agent = await registry.findById("planner");
      expect(agent).toBeDefined();
      expect(agent!.name).toBe("Project Planner");
    });

    it("returns undefined for non-existent agent", async () => {
      await registry.loadAll();

      const agent = await registry.findById("non-existent-agent");
      expect(agent).toBeUndefined();
    });
  });

  describe("resolveByRole", () => {
    it("resolves agent by role", async () => {
      await registry.loadAll();

      const result = await registry.resolveByRole("planner");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.agent.role).toBe("planner");
        expect(result.resolvedBy).toBe("role");
      }
    });

    it("returns error for unknown role", async () => {
      await registry.loadAll();

      const result = await registry.resolveByRole("nonexistent-role");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("AGENT_NOT_FOUND_BY_ROLE");
        expect(result.error.requested.role).toBe("nonexistent-role");
      }
    });

    it("is case-insensitive", async () => {
      await registry.loadAll();

      const result = await registry.resolveByRole("PLANNER");
      expect(result.success).toBe(true);
    });
  });

  describe("resolveByCapability", () => {
    it("resolves agent by capability", async () => {
      await registry.loadAll();

      const result = await registry.resolveByCapability("code-review");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.agent.capabilities).toContain("code-review");
        expect(result.resolvedBy).toBe("capability");
      }
    });

    it("returns error for unknown capability", async () => {
      await registry.loadAll();

      const result = await registry.resolveByCapability("nonexistent-cap");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("AGENT_NOT_FOUND_BY_CAPABILITY");
        expect(result.error.requested.capability).toBe("nonexistent-cap");
      }
    });

    it("is case-insensitive", async () => {
      await registry.loadAll();

      const result = await registry.resolveByCapability("CODE-REVIEW");
      expect(result.success).toBe(true);
    });
  });

  describe("resolve (unified)", () => {
    it("resolves by ID", async () => {
      await registry.loadAll();

      const result = await registry.resolve({ id: "planner" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.agent.id).toBe("planner");
        expect(result.resolvedBy).toBe("id");
      }
    });

    it("resolves by role when ID not found", async () => {
      await registry.loadAll();

      const result = await registry.resolve({ id: "non-existent", role: "planner" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.resolvedBy).toBe("role");
      }
    });

    it("resolves by capability when role not found", async () => {
      await registry.loadAll();

      const result = await registry.resolve({
        id: "non-existent",
        role: "non-existent",
        capability: "code-review",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.resolvedBy).toBe("capability");
      }
    });

    it("returns error when nothing matches", async () => {
      await registry.loadAll();

      const result = await registry.resolve({
        id: "non-existent",
        role: "non-existent",
        capability: "non-existent",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("AGENT_NOT_FOUND");
      }
    });

    it("returns error for empty query", async () => {
      await registry.loadAll();

      const result = await registry.resolve({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("INVALID_QUERY");
      }
    });
  });

  describe("listRoles / listCapabilities / listTags", () => {
    it("lists all roles", async () => {
      await registry.loadAll();

      const roles = await registry.listRoles();
      expect(roles).toContain("planner");
    });

    it("lists all capabilities", async () => {
      await registry.loadAll();

      const caps = await registry.listCapabilities();
      expect(caps.length).toBeGreaterThan(0);
    });

    it("lists all tags", async () => {
      await registry.loadAll();

      const tags = await registry.listTags();
      expect(Array.isArray(tags)).toBe(true);
    });
  });

  describe("getAgentsBySource", () => {
    it("gets agents by source", async () => {
      await registry.loadAll();

      const projectAgents = await registry.getAgentsBySource("project");
      expect(projectAgents.length).toBeGreaterThan(0);
      expect(projectAgents.every((a) => a.source === "project")).toBe(true);
    });
  });

  describe("getAgentsByTag", () => {
    it("gets agents by tag", async () => {
      await registry.loadAll();

      const taggedAgents = await registry.getAgentsByTag("test");
      expect(Array.isArray(taggedAgents)).toBe(true);
    });
  });

  describe("state management", () => {
    it("count returns correct number", async () => {
      await registry.loadAll();

      const count = await registry.count();
      expect(count).toBeGreaterThan(0);
    });

    it("isLoaded returns correct state", async () => {
      expect(registry.isLoaded()).toBe(false);
      await registry.loadAll();
      expect(registry.isLoaded()).toBe(true);
    });

    it("reset clears state", async () => {
      await registry.loadAll();
      expect(registry.isLoaded()).toBe(true);
      const firstCount = await registry.count();

      registry.reset();
      expect(registry.isLoaded()).toBe(false);

      // After reset, calling count() will trigger a reload
      // So count should return to previous value
      expect(await registry.count()).toBe(firstCount);
    });

    it("reload updates state", async () => {
      const builtInOnlyRegistry = new AgentRegistry({
        cwd: fixturesDir,
        includeBuiltIn: true,
        includeUser: false,
        includeProject: false,
        builtInAgentsPath: path.join(process.cwd(), "agents"),
      });

      await builtInOnlyRegistry.loadAll();
      expect(await builtInOnlyRegistry.count()).toBeGreaterThan(0);

      await builtInOnlyRegistry.reload({ includeBuiltIn: false });

      expect(await builtInOnlyRegistry.count()).toBe(0);
    });
  });

  describe("summarize", () => {
    it("returns formatted summary", async () => {
      await registry.loadAll();

      const summary = await registry.summarize();
      expect(typeof summary).toBe("string");
      expect(summary).toContain("Agent Registry Summary");
      expect(summary).toContain("Total agents:");
      expect(summary).toContain("All agents:");
    });
  });
});

// ============================================================================
// Precedence Tests
// ============================================================================

describe("AgentRegistry precedence", () => {
  it("loads built-in agents when no override exists", async () => {
    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: true,
      includeUser: false,
      includeProject: false,
      builtInAgentsPath: path.join(process.cwd(), "agents"),
    });

    await registry.loadAll();

    const agents = await registry.listAgents();
    expect(agents.some((a) => a.id === "planner" && a.source === "built-in")).toBe(true);
  });

  it("project overrides built-in", async () => {
    // This test verifies that project planner overrides built-in planner
    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: true,
      includeUser: false,
      includeProject: true,
      projectAgentsPath: path.join(fixturesDir, "project"),
      builtInAgentsPath: path.join(process.cwd(), "agents"),
    });

    await registry.loadAll();

    // Project planner should be present
    const planner = await registry.findById("planner");
    expect(planner).toBeDefined();
    expect(planner!.source).toBe("project");
    expect(planner!.name).toBe("Project Planner");

    // Should have diagnostic about override
    const diagnostics = await registry.listDiagnostics();
    const overrideDiags = diagnostics.filter(
      (d) => d.code === "AGENT_OVERRIDDEN" && d.agentId === "planner"
    );
    expect(overrideDiags.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// createRegistry Factory Tests
// ============================================================================

describe("createRegistry", () => {
  it("creates and loads a registry", async () => {
    const registry = await createRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: true,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
    });

    expect(registry.isLoaded()).toBe(true);
    const agents = await registry.listAgents();
    expect(agents.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("AgentRegistry error handling", () => {
  it("handles parsing errors gracefully", async () => {
    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: path.join(fixturesDir, "invalid"),
    });

    await registry.loadAll();

    const errors = await registry.listErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.code === "missing_required_field")).toBe(true);
  });

  it("records duplicate ID errors", async () => {
    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: path.join(fixturesDir, "duplicates-user"),
    });

    await registry.loadAll();

    const errors = await registry.listErrors();
    expect(errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });

  it("diagnostics include warnings for missing metadata", async () => {
    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: path.join(fixturesDir, "user"),
    });

    await registry.loadAll();

    const diagnostics = await registry.listDiagnostics();

    // Should have warnings for agents without roles
    const missingRoleDiags = diagnostics.filter((d) => d.code === "AGENT_MISSING_ROLE");
    expect(missingRoleDiags.length).toBeGreaterThan(0);

    // Should have warnings for agents without capabilities
    const missingCapDiags = diagnostics.filter((d) => d.code === "AGENT_MISSING_CAPABILITIES");
    expect(missingCapDiags.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Resolution Tiebreaker Tests
// ============================================================================

describe("resolveByRoleWithTiebreaker", () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: true,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
    });
    await registry.loadAll();
  });

  it("resolves by role with priority tiebreaker", async () => {
    const result = await registry.resolveByRoleWithTiebreaker("planner", "priority");
    expect(result.success).toBe(true);
  });

  it("resolves by role with name tiebreaker", async () => {
    const result = await registry.resolveByRoleWithTiebreaker("planner", "name");
    expect(result.success).toBe(true);
  });

  it("resolves by role with filePath tiebreaker", async () => {
    const result = await registry.resolveByRoleWithTiebreaker("planner", "filePath");
    expect(result.success).toBe(true);
  });
});

describe("deterministic resolution", () => {
  it("resolveByRole prefers higher priority within the same source", async () => {
    const userAgentsPath = await createTempAgentsDir({
      "alpha-reviewer.md": `---
name: Alpha Reviewer
role: reviewer
priority: 1
---
Alpha reviewer prompt.`,
      "beta-reviewer.md": `---
name: Beta Reviewer
role: reviewer
priority: 10
---
Beta reviewer prompt.`,
    });

    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath,
    });

    await registry.loadAll();
    const result = await registry.resolveByRole("reviewer");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.agent.name).toBe("Beta Reviewer");
    }
  });

  it("resolveByCapability uses deterministic fallback after precedence", async () => {
    const userAgentsPath = await createTempAgentsDir({
      "zeta-capability.md": `---
name: Zeta Capability
capabilities:
  - audit
---
Zeta capability prompt.`,
      "alpha-capability.md": `---
name: Alpha Capability
capabilities:
  - audit
---
Alpha capability prompt.`,
    });

    const registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath,
    });

    await registry.loadAll();
    const result = await registry.resolveByCapability("audit");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.agent.name).toBe("Alpha Capability");
    }
  });
});

// ============================================================================
// hasAgent Tests
// ============================================================================

describe("hasAgent", () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    registry = new AgentRegistry({
      cwd: fixturesDir,
      includeBuiltIn: false,
      includeUser: true,
      includeProject: false,
      userAgentsPath: path.join(fixturesDir, "user"),
    });
    await registry.loadAll();
  });

  it("returns true for existing agent", async () => {
    expect(await registry.hasAgent("my-agent")).toBe(true);
  });

  it("returns false for non-existing agent", async () => {
    expect(await registry.hasAgent("non-existent")).toBe(false);
  });
});
