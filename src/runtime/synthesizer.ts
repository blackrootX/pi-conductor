// src/runtime/synthesizer.ts - Synthesis layer for workflow results

import type {
  ResolvedWorkflow,
  StepResultEnvelope,
  SynthesisStrategy,
} from "../workflow/types";

export interface SynthesisResult {
  summary: string;
  finalText: string;
  strategy: SynthesisStrategy;
  stepsIncluded: string[];
  success: boolean;
}

/**
 * Synthesizer combines step results into a final workflow output.
 * 
 * Synthesis strategies:
 * - "lead": Use the result from the first step (default)
 * - "all": Include all step results
 * - "concise": Combine all results into a concise summary
 */
export class Synthesizer {
  /**
   * Synthesize workflow results into a final output.
   */
  synthesize(
    workflow: ResolvedWorkflow,
    results: Record<string, StepResultEnvelope>
  ): SynthesisResult {
    const strategy = workflow.synthesis.strategy;
    const steps = Object.values(results).sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    );

    const successfulSteps = steps.filter((s) => s.status === "succeeded");
    const failedSteps = steps.filter((s) => s.status === "failed");

    let summary: string;
    let finalText: string;
    let stepsIncluded: string[];

    switch (strategy) {
      case "lead":
        ({ summary, finalText, stepsIncluded } = this.synthesizeLead(steps));
        break;
      case "all":
        ({ summary, finalText, stepsIncluded } = this.synthesizeAll(steps));
        break;
      case "concise":
        ({ summary, finalText, stepsIncluded } = this.synthesizeConcise(successfulSteps));
        break;
      default:
        ({ summary, finalText, stepsIncluded } = this.synthesizeLead(steps));
    }

    return {
      summary,
      finalText,
      strategy,
      stepsIncluded,
      success: failedSteps.length === 0,
    };
  }

  /**
   * Lead strategy: Use the last step's result as the final output.
   * Good for sequential workflows where the final step has the complete result.
   */
  private synthesizeLead(steps: StepResultEnvelope[]): {
    summary: string;
    finalText: string;
    stepsIncluded: string[];
  } {
    if (steps.length === 0) {
      return {
        summary: "No steps were executed",
        finalText: "No workflow steps were executed.",
        stepsIncluded: [],
      };
    }

    // Find successful steps in order, use the last one
    const completedSteps = steps.filter((s) => s.status === "succeeded");

    if (completedSteps.length === 0) {
      return {
        summary: `All ${steps.length} step(s) failed`,
        finalText: this.formatFailedSteps(steps),
        stepsIncluded: [],
      };
    }

    // Use the last completed step (for sequential workflows, this is the final step)
    const leadStep = completedSteps[completedSteps.length - 1];
    const stepsIncluded = [leadStep.stepId];

    // Build summary
    const summaryParts = [`Lead step "${leadStep.stepTitle}" completed`];

    if (completedSteps.length > 1) {
      summaryParts.push(`(+${completedSteps.length - 1} additional completed step(s))`);
    }

    const failedCount = steps.filter((s) => s.status === "failed").length;
    if (failedCount > 0) {
      summaryParts.push(`(${failedCount} step(s) failed)`);
    }

    // Build final text
    const finalText = this.formatStepResult(leadStep);

    return {
      summary: summaryParts.join(" "),
      finalText,
      stepsIncluded,
    };
  }

  /**
   * All strategy: Include all step results in the final output.
   * Good for parallel workflows where all results are valuable.
   */
  private synthesizeAll(steps: StepResultEnvelope[]): {
    summary: string;
    finalText: string;
    stepsIncluded: string[];
  } {
    if (steps.length === 0) {
      return {
        summary: "No steps were executed",
        finalText: "No workflow steps were executed.",
        stepsIncluded: [],
      };
    }

    const completedSteps = steps.filter((s) => s.status === "succeeded");
    const failedSteps = steps.filter((s) => s.status === "failed");
    const stepsIncluded = completedSteps.map((s) => s.stepId);

    const lines: string[] = [];

    // Summary
    lines.push("# Workflow Results\n");

    if (completedSteps.length > 0) {
      lines.push(`## Succeeded (${completedSteps.length})\n`);
      for (const step of completedSteps) {
        lines.push(`### ${step.stepTitle}`);
        lines.push("");
        lines.push(this.formatStepResult(step));
        lines.push("");
      }
    }

    if (failedSteps.length > 0) {
      lines.push(`## Failed (${failedSteps.length})\n`);
      for (const step of failedSteps) {
        lines.push(`### ${step.stepTitle}`);
        lines.push(`**Error:** ${step.error || "Unknown error"}`);
        lines.push("");
      }
    }

    const summary = `${completedSteps.length} step(s) succeeded, ${failedSteps.length} failed`;
    const finalText = lines.join("\n");

    return {
      summary,
      finalText,
      stepsIncluded,
    };
  }

  /**
   * Concise strategy: Combine all results into a brief summary.
   * Good for parallel audit workflows where you want a quick overview.
   */
  private synthesizeConcise(steps: StepResultEnvelope[]): {
    summary: string;
    finalText: string;
    stepsIncluded: string[];
  } {
    if (steps.length === 0) {
      return {
        summary: "No steps were executed",
        finalText: "No workflow steps were executed.",
        stepsIncluded: [],
      };
    }

    const completedSteps = steps.filter((s) => s.status === "succeeded");
    const failedSteps = steps.filter((s) => s.status === "failed");
    const stepsIncluded = completedSteps.map((s) => s.stepId);

    const lines: string[] = [];

    // Brief summary
    lines.push("# Summary\n");
    lines.push(`- **Succeeded:** ${completedSteps.length}`);
    lines.push(`- **Failed:** ${failedSteps.length}`);
    lines.push("");

    // Quick status for each step
    lines.push("## Status\n");
    for (const step of steps) {
      const icon = step.status === "succeeded" ? "✓" : 
                   step.status === "cancelled" ? "⚠" :
                   step.status === "timed_out" ? "⏱" : "✗";
      const title = step.stepTitle;
      lines.push(`${icon} ${title}`);
    }
    lines.push("");

    // Key findings (from completed steps)
    if (completedSteps.length > 0) {
      lines.push("## Key Results\n");
      for (const step of completedSteps) {
        lines.push(`### ${step.stepTitle}`);
        // Only show first 200 chars of summary
        const summaryText = step.summary.length > 200
          ? step.summary.slice(0, 200) + "..."
          : step.summary;
        lines.push(summaryText);
        lines.push("");
      }
    }

    // Errors if any
    if (failedSteps.length > 0) {
      lines.push("## Errors\n");
      for (const step of failedSteps) {
        lines.push(`**${step.stepTitle}:** ${step.error || "Unknown error"}`);
      }
    }

    const summary = `${completedSteps.length}/${steps.length} succeeded (concise)`;
    const finalText = lines.join("\n");

    return {
      summary,
      finalText,
      stepsIncluded,
    };
  }

  /**
   * Format a single step result for display.
   */
  private formatStepResult(step: StepResultEnvelope): string {
    const lines: string[] = [];

    // Summary section
    if (step.summary) {
      lines.push("### Summary");
      lines.push("");
      lines.push(step.summary);
      lines.push("");
    }

    // Artifact section (if present and not empty)
    if (step.artifact?.value) {
      lines.push("### Result");
      lines.push("");

      if (step.artifact.type === "json") {
        const formatted = typeof step.artifact.value === "string"
          ? step.artifact.value
          : JSON.stringify(step.artifact.value, null, 2);
        lines.push("```json");
        lines.push(formatted);
        lines.push("```");
      } else {
        const value = typeof step.artifact.value === "string"
          ? step.artifact.value
          : JSON.stringify(step.artifact.value, null, 2);
        lines.push(value);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Format failed steps for display.
   */
  private formatFailedSteps(steps: StepResultEnvelope[]): string {
    const lines: string[] = [];

    lines.push("# Workflow Failed\n");
    lines.push("");

    for (const step of steps) {
      lines.push(`## ${step.stepTitle}`);
      lines.push(`**Status:** ${step.status}`);
      if (step.error) {
        lines.push(`**Error:** ${step.error}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

/**
 * Create a synthesizer instance.
 */
export function createSynthesizer(): Synthesizer {
  return new Synthesizer();
}
