// src/runtime/synthesizer.ts - Merge outputs and produce final result

import type {
  ResolvedWorkflow,
  StepResultEnvelope,
  SynthesisStrategy,
} from "../workflow/types";

export interface SynthesisResult {
  summary: string;
  finalText: string;
  stepsIncluded: string[];
  strategy: SynthesisStrategy;
}

/**
 * Synthesizer that merges step results into a final output.
 */
export class Synthesizer {
  /**
   * Synthesize results from all steps into a final output.
   */
  synthesize(
    workflow: ResolvedWorkflow,
    results: Record<string, StepResultEnvelope>
  ): SynthesisResult {
    const completedSteps = Object.values(results)
      .filter((r) => r.status === "completed")
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

    const strategy = workflow.synthesis.strategy || "lead";
    const stepsIncluded = completedSteps.map((s) => s.stepId);

    let summary: string;
    let finalText: string;

    switch (strategy) {
      case "lead":
        ({ summary, finalText } = this.synthesizeLead(workflow, completedSteps));
        break;
      case "all":
        ({ summary, finalText } = this.synthesizeAll(completedSteps));
        break;
      case "concise":
        ({ summary, finalText } = this.synthesizeConcise(workflow, completedSteps));
        break;
      default:
        ({ summary, finalText } = this.synthesizeLead(workflow, completedSteps));
    }

    return {
      summary,
      finalText,
      stepsIncluded,
      strategy,
    };
  }

  /**
   * Lead strategy: return the last step's output as the final answer.
   * Best for: plan → implement → review workflows
   */
  private synthesizeLead(
    workflow: ResolvedWorkflow,
    results: StepResultEnvelope[]
  ): { summary: string; finalText: string } {
    if (results.length === 0) {
      return {
        summary: "No steps completed successfully.",
        finalText: "Workflow completed but no results were generated.",
      };
    }

    // Get the last completed step
    const leadResult = results[results.length - 1];

    // If there's a review step, prefer that
    const reviewStep = results.find((r) =>
      r.stepId.toLowerCase().includes("review")
    );
    const finalResult = reviewStep || leadResult;

    const summary = `Completed ${results.length} steps. Final result from ${finalResult.stepTitle}.`;

    const finalText = this.formatStepOutput(finalResult);

    return { summary, finalText };
  }

  /**
   * All strategy: include output from all steps.
   * Best for: parallel audit workflows
   */
  private synthesizeAll(
    results: StepResultEnvelope[]
  ): { summary: string; finalText: string } {
    if (results.length === 0) {
      return {
        summary: "No steps completed successfully.",
        finalText: "Workflow completed but no results were generated.",
      };
    }

    const lines: string[] = [];

    lines.push("# Workflow Results\n");

    for (const result of results) {
      lines.push(`## ${result.stepTitle}`);
      lines.push(`**Agent:** ${result.agentName}`);
      lines.push(`**Status:** ${result.status}`);
      lines.push("");
      lines.push(this.formatStepOutput(result));
      lines.push("");
      lines.push("---\n");
    }

    const summary = `Completed ${results.length} steps with all outputs included.`;

    return {
      summary,
      finalText: lines.join("\n"),
    };
  }

  /**
   * Concise strategy: summarize each step briefly.
   * Best for: parallel audits, quick reviews
   */
  private synthesizeConcise(
    workflow: ResolvedWorkflow,
    results: StepResultEnvelope[]
  ): { summary: string; finalText: string } {
    if (results.length === 0) {
      return {
        summary: "No steps completed successfully.",
        finalText: "Workflow completed but no results were generated.",
      };
    }

    const lines: string[] = [];

    lines.push("# Summary\n");

    for (const result of results) {
      lines.push(`- **${result.stepTitle}** (${result.agentName}): ${result.summary}`);
    }

    // Get the last result for detailed output
    const lastResult = results[results.length - 1];

    lines.push("\n## Details\n");
    lines.push(this.formatStepOutput(lastResult));

    const summary = `Synthesized results from ${results.length} steps into a concise summary.`;

    return {
      summary,
      finalText: lines.join("\n"),
    };
  }

  /**
   * Format a step's output for display.
   */
  private formatStepOutput(result: StepResultEnvelope): string {
    if (result.artifact.type === "json") {
      return `\`\`\`json\n${JSON.stringify(result.artifact.value, null, 2)}\n\`\`\``;
    }

    if (typeof result.artifact.value === "string" && result.artifact.value.trim()) {
      return result.artifact.value;
    }

    return result.summary || "(No detailed output)";
  }

  /**
   * Format errors for display.
   */
  formatErrors(results: Record<string, StepResultEnvelope>): string {
    const failed = Object.values(results).filter((r) => r.status === "failed");

    if (failed.length === 0) {
      return "";
    }

    const lines: string[] = [];
    lines.push("## Errors\n");

    for (const result of failed) {
      lines.push(`### ${result.stepTitle}`);
      lines.push(`**Agent:** ${result.agentName}`);
      lines.push(`**Error:** ${result.error || "Unknown error"}`);
      lines.push("");
    }

    return lines.join("\n");
  }
}

/**
 * Create a synthesizer with default settings.
 */
export function createSynthesizer(): Synthesizer {
  return new Synthesizer();
}
