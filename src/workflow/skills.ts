// src/workflow/skills.ts - Helpers for workflow skill configuration

export function normalizeWorkflowSkills(skills?: string[]): string[] {
  if (!skills || skills.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      skills
        .map((skill) => skill.trim())
        .filter(Boolean)
    )
  );
}

export function mergeWorkflowSkills(
  workflowSharedSkills?: string[],
  stepSkills?: string[]
): string[] {
  return normalizeWorkflowSkills([
    ...(workflowSharedSkills ?? []),
    ...(stepSkills ?? []),
  ]);
}

export function formatSkillsForPrompt(skills?: string[]): string | null {
  const normalized = normalizeWorkflowSkills(skills);
  if (normalized.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("## Skills");
  lines.push("");
  lines.push("Use the following Pi skills if they are available in this environment:");
  lines.push("");

  for (const skill of normalized) {
    const label = skill.startsWith("$") ? skill : `$${skill}`;
    lines.push(`- ${label}`);
  }

  return lines.join("\n");
}
