// test/index.test.ts - Tests for agent parsing, normalization, and resolution

import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadAgentFile,
  loadAllAgents,
  findAgent,
  summarizeAgents,
} from "../src/index";
import type { AgentSpec, StructuredError } from "../src/index";
import {
  normalizeId,
  isValidId,
  deduplicateStrings,
  normalizeAgent,
  detectDuplicateIds,
} from "../src/normalizer";
import {
  parseMarkdown,
  extractFrontmatter,
  parseYaml,
} from "../src/parser";
import {
  invalidFrontmatterError,
  invalidYamlError,
  missingRequiredFieldError,
  emptyBodyError,
  invalidFieldTypeError,
} from "../src/errors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

// ============================================================================
// ID Normalization Tests
// ============================================================================

describe("normalizeId", () => {
  it("converts to lowercase", () => {
    expect(normalizeId("MyAgent")).toBe("myagent");
    expect(normalizeId("UPPERCASE")).toBe("uppercase");
  });

  it("converts spaces to hyphens", () => {
    expect(normalizeId("my agent")).toBe("my-agent");
    expect(normalizeId("agent with multiple words")).toBe("agent-with-multiple-words");
  });

  it("converts underscores to hyphens", () => {
    expect(normalizeId("my_agent")).toBe("my-agent");
    expect(normalizeId("snake_case_agent")).toBe("snake-case-agent");
  });

  it("converts dots to hyphens", () => {
    expect(normalizeId("my.agent")).toBe("my-agent");
    expect(normalizeId("agent.file.name")).toBe("agent-file-name");
  });

  it("collapses multiple separators to single hyphen", () => {
    expect(normalizeId("my___agent")).toBe("my-agent");
    expect(normalizeId("my---agent")).toBe("my-agent");
    expect(normalizeId("my - agent")).toBe("my-agent");
    expect(normalizeId("a.b_c-d")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens", () => {
    expect(normalizeId("-myagent-")).toBe("myagent");
    expect(normalizeId("--agent--")).toBe("agent");
  });

  it("removes .md extension", () => {
    expect(normalizeId("agent.md")).toBe("agent");
    expect(normalizeId("AGENT.MD")).toBe("agent");
  });

  it("preserves Unicode characters", () => {
    expect(normalizeId("test_日本語")).toBe("test-日本語");
    expect(normalizeId("émoji_agent")).toBe("émoji-agent");
  });

  it("handles mixed case with separators", () => {
    expect(normalizeId("My_Agent-Name")).toBe("my-agent-name");
    expect(normalizeId("Mixed_Separators-Agent")).toBe("mixed-separators-agent");
  });
});

describe("isValidId", () => {
  it("returns true for non-empty IDs", () => {
    expect(isValidId("myagent")).toBe(true);
    expect(isValidId("my-agent")).toBe(true);
    expect(isValidId("日本語")).toBe(true);
  });

  it("returns false for empty ID", () => {
    expect(isValidId("")).toBe(false);
    expect(isValidId("---")).toBe(false);
  });
});

// ============================================================================
// Deduplication Tests
// ============================================================================

describe("deduplicateStrings", () => {
  it("removes duplicates while preserving order", () => {
    expect(deduplicateStrings(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateStrings([])).toEqual([]);
  });

  it("returns same array when no duplicates", () => {
    expect(deduplicateStrings(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

// ============================================================================
// Parser Tests
// ============================================================================

describe("extractFrontmatter", () => {
  it("extracts frontmatter from markdown", () => {
    const result = extractFrontmatter(`---
name: Test
---
Body content`);
    expect(result.frontmatter).toBe("name: Test");
    expect(result.content).toBe("Body content");
  });

  it("handles CRLF line endings", () => {
    const result = extractFrontmatter("---\r\nname: Test\r\n---\r\nBody");
    expect(result.frontmatter).toBe("name: Test");
    expect(result.content).toBe("Body");
  });

  it("returns null frontmatter when not present", () => {
    const result = extractFrontmatter("Just body content");
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe("Just body content");
  });

  it("handles frontmatter with arrays", () => {
    const result = extractFrontmatter(`---
name: Test
tools:
  - read
  - write
---
Body`);
    expect(result.frontmatter).toContain("name: Test");
    expect(result.frontmatter).toContain("- read");
  });
});

describe("parseYaml", () => {
  it("parses simple key-value pairs", () => {
    const result = parseYaml("name: Test\ndescription: A test");
    expect(result).toEqual({
      name: "Test",
      description: "A test",
    });
  });

  it("parses quoted strings", () => {
    const result = parseYaml('name: "Test"\ndescription: \'Another\'');
    expect(result).toEqual({
      name: "Test",
      description: "Another",
    });
  });

  it("parses booleans", () => {
    const result = parseYaml("active: true\ndisabled: false");
    expect(result).toEqual({
      active: true,
      disabled: false,
    });
  });

  it("parses numbers", () => {
    const result = parseYaml("count: 42\nratio: 3.14");
    expect(result).toEqual({
      count: 42,
      ratio: 3.14,
    });
  });

  it("parses arrays", () => {
    const result = parseYaml(`tools:
  - read
  - write
  - bash`);
    expect(result).toEqual({
      tools: ["read", "write", "bash"],
    });
  });

  it("returns null for empty string", () => {
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("   ")).toBeNull();
  });

  it("throws for malformed YAML", () => {
    expect(() => parseYaml('name: "unterminated')).toThrow();
  });
});

describe("parseMarkdown", () => {
  it("parses valid markdown with frontmatter", () => {
    const result = parseMarkdown(`---
name: Test Agent
description: A test
---
This is the body.`);
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.frontmatter).toEqual({ name: "Test Agent", description: "A test" });
    expect(result.body).toBe("This is the body.");
  });

  it("returns error for missing frontmatter", () => {
    const result = parseMarkdown("Just body content");
    expect(result).toEqual(invalidFrontmatterError());
  });

  it("returns error for empty frontmatter", () => {
    const result = parseMarkdown("---\n---\nBody");
    expect(result).toEqual(invalidFrontmatterError());
  });

  it("returns error for empty body", () => {
    const result = parseMarkdown(`---
name: Test
---
   `);
    expect(result).toEqual(emptyBodyError());
  });

  it("returns error for malformed YAML", () => {
    const result = parseMarkdown(`---
name: "unterminated
---
Body`);
    expect(result).toEqual(invalidYamlError());
  });
});

// ============================================================================
// Normalizer Tests
// ============================================================================

describe("detectDuplicateIds", () => {
  it("detects duplicates across sources", () => {
    const agents = [
      { id: "agent-1", filePath: "/path/a1.md", source: "user" },
      { id: "agent-2", filePath: "/path/a2.md", source: "user" },
      { id: "agent-1", filePath: "/path2/a1.md", source: "project" },
    ];

    const result = detectDuplicateIds(agents);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].id).toBe("agent-1");
    expect(result.duplicates[0].files).toContain("/path/a1.md");
    expect(result.duplicates[0].files).toContain("/path2/a1.md");
  });

  it("does not report same file twice", () => {
    const agents = [
      { id: "agent-1", filePath: "/path/a1.md", source: "user" },
      { id: "agent-1", filePath: "/path/a1.md", source: "user" },
    ];

    const result = detectDuplicateIds(agents);
    expect(result.duplicates).toHaveLength(0);
  });
});

// ============================================================================
// Error Type Tests
// ============================================================================

describe("Error factories", () => {
  it("invalidFrontmatterError", () => {
    expect(invalidFrontmatterError("/path/file.md")).toEqual({
      code: "invalid_frontmatter",
      message: "Missing or invalid frontmatter",
      source: "/path/file.md",
    });
  });

  it("missingRequiredFieldError", () => {
    expect(missingRequiredFieldError("name", "/path/file.md")).toEqual({
      code: "missing_required_field",
      message: "Missing required field: name",
      source: "/path/file.md",
      field: "name",
    });
  });

  it("emptyBodyError", () => {
    expect(emptyBodyError()).toEqual({
      code: "empty_body",
      message: "Agent body (system prompt) cannot be empty",
    });
  });

  it("invalidFieldTypeError", () => {
    expect(invalidFieldTypeError("priority", "number", "high", "/path.md")).toEqual({
      code: "invalid_field_type",
      message: 'Field "priority" expected number, got string',
      source: "/path.md",
      field: "priority",
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("loadAgentFile", () => {
  it("loads a valid user agent", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "user", "my_agent.md"),
      "user"
    );

    expect(result.errors).toHaveLength(0);
    expect(result.agent).toBeDefined();
    expect(result.agent!.id).toBe("my-agent");
    expect(result.agent!.name).toBe("My Custom Agent");
    expect(result.agent!.source).toBe("user");
    expect(result.agent!.systemPrompt).toContain("custom user agent");
  });

  it("handles spaces in filename", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "user", "special agent with spaces.md"),
      "user"
    );

    expect(result.errors).toHaveLength(0);
    expect(result.agent!.id).toBe("special-agent-with-spaces");
  });

  it("handles Unicode in filename", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "user", "unicode_agent_日本語.md"),
      "user"
    );

    expect(result.errors).toHaveLength(0);
    expect(result.agent!.id).toBe("unicode-agent-日本語");
  });

  it("returns error for invalid agent", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "invalid", "no_name.md"),
      "user"
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].code).toBe("missing_required_field");
    expect(result.agent).toBeUndefined();
  });

  it("returns error for agent without frontmatter", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "invalid", "no_frontmatter.md"),
      "user"
    );

    expect(result.errors[0].code).toBe("invalid_frontmatter");
  });

  it("returns error for agent with empty body", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "invalid", "empty_body.md"),
      "user"
    );

    expect(result.errors[0].code).toBe("empty_body");
  });

  it("returns errors for wrong field types", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "invalid", "wrong_field_types.md"),
      "user"
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === "invalid_field_type")).toBe(true);
  });
});

describe("loadAllAgents", () => {
  it("loads agents from fixtures", async () => {
    // Override paths for testing
    const result = await loadAllAgents({
      cwd: fixturesDir,
      includeBuiltIn: false,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
    });

    // Should have loaded user and project agents
    expect(result.agents.length).toBeGreaterThan(0);

    // Should not have errors for valid agents
    const errorCodes = result.errors.map((e) => e.code);
    expect(errorCodes).not.toContain("invalid_frontmatter");
    expect(errorCodes).not.toContain("empty_body");
  });

  it("handles project override of user agent", async () => {
    const result = await loadAllAgents({
      cwd: fixturesDir,
      includeBuiltIn: true,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
      builtInAgentsPath: path.join(process.cwd(), "agents"),
    });

    // Find the planner agent
    const planner = result.agents.find((a) => a.id === "planner");

    // Project planner should override built-in planner
    expect(planner).toBeDefined();
    expect(planner!.name).toBe("Project Planner");
    expect(planner!.source).toBe("project");
  });

  it("reports duplicate IDs within same source as errors", async () => {
    const result = await loadAllAgents({
      cwd: fixturesDir,
      includeBuiltIn: false,
      userAgentsPath: path.join(fixturesDir, "duplicates-user"),
      includeProject: false,
    });

    expect(result.errors.some((error) => error.code === "duplicate_id")).toBe(true);
    expect(result.agents.find((agent) => agent.id === "duplicate-agent")).toBeUndefined();
  });

  it("loads built-in agents with correct provenance", async () => {
    const result = await loadAllAgents({
      cwd: fixturesDir,
      includeBuiltIn: true,
      includeUser: false,
      includeProject: false,
      builtInAgentsPath: path.join(process.cwd(), "agents"),
    });

    const reviewer = result.agents.find((agent) => agent.id === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe("built-in");
    expect(reviewer!.filePath).toContain(path.join("agents", "reviewer.md"));
  });
});

describe("findAgent", () => {
  it("finds an agent by ID with precedence", async () => {
    const result = await findAgent("planner", {
      cwd: fixturesDir,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
    });

    expect(result.agent).toBeDefined();
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty result for non-existent agent", async () => {
    const result = await findAgent("nonexistent-agent", {
      cwd: fixturesDir,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
    });

    expect(result.agent).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  it("returns error for invalid ID", async () => {
    const result = await findAgent("---", { cwd: fixturesDir });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].code).toBe("invalid_id");
  });
});

describe("summarizeAgents", () => {
  it("formats agents for display", async () => {
    const result = await loadAllAgents({
      cwd: fixturesDir,
      includeBuiltIn: false,
      userAgentsPath: path.join(fixturesDir, "user"),
      projectAgentsPath: path.join(fixturesDir, "project"),
    });

    const summary = summarizeAgents(result.agents);

    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
    // Should contain source indicators with correct padding (10 chars padded)
    expect(summary).toContain("[user      ]");
    expect(summary).toContain("[project   ]");
  });
});

// ============================================================================
// Type Tests
// ============================================================================

describe("AgentSpec structure", () => {
  it("has all required fields", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "user", "my_agent.md"),
      "user"
    );

    const agent = result.agent!;
    expect(typeof agent.id).toBe("string");
    expect(typeof agent.name).toBe("string");
    expect(typeof agent.systemPrompt).toBe("string");
    expect(["built-in", "user", "project"]).toContain(agent.source);
  });

  it("preserves optional fields", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "user", "my_agent.md"),
      "user"
    );

    const agent = result.agent!;
    expect(agent.description).toBe("A custom user agent for testing");
    expect(agent.tools).toEqual(["read", "write", "bash"]);
    expect(agent.tags).toEqual(["custom", "test"]);
  });

  it("stores unknown fields in metadata", async () => {
    const result = await loadAgentFile(
      path.join(fixturesDir, "user", "my_agent.md"),
      "user"
    );

    // my_agent.md doesn't have unknown fields, so metadata should be undefined
    // or empty
    expect(result.agent!.metadata).toBeUndefined();
  });

  it("deduplicates array fields", async () => {
    // Create a test case with duplicates
    const content = `---
name: Test Dedupe
tools:
  - read
  - write
  - read
  - bash
  - write
---
Test body`;

    const parsed = parseMarkdown(content);
    expect("code" in parsed).toBe(false);
    if ("code" in parsed) return;

    const normalized = normalizeAgent(parsed, "test-dedupe", "user");
    expect(normalized.agent).toBeDefined();
    expect(normalized.agent!.spec.tools).toEqual(["read", "write", "bash"]);
  });
});
