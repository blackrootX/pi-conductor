import {
  getMarkdownTheme,
  type ExtensionAPI,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
  WORKFLOW_MESSAGE_TYPE,
  type WorkflowMessageDetails,
} from "./workflow-session-entries.js";

function statusColor(
  status: WorkflowMessageDetails["snapshot"]["status"],
): "success" | "error" | "warning" | "muted" {
  switch (status) {
    case "done":
      return "success";
    case "blocked":
    case "failed":
      return "error";
    case "running":
      return "warning";
    default:
      return "muted";
  }
}

function statusIcon(status: WorkflowMessageDetails["snapshot"]["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "blocked":
    case "failed":
      return "✗";
    case "running":
      return "◐";
    default:
      return "○";
  }
}

function eventLabel(event: WorkflowMessageDetails["event"]): string {
  switch (event) {
    case "run-started":
      return "started";
    case "step-updated":
      return "progress";
    case "step-finished":
      return "step finished";
    case "run-finished":
      return "finished";
  }
}

function renderList(
  title: string,
  items: string[],
  theme: Theme,
): Text | undefined {
  if (items.length === 0) return undefined;
  const lines = [theme.fg("muted", `${title}:`), ...items.map((item) => `- ${item}`)];
  return new Text(lines.join("\n"), 0, 0);
}

export function registerWorkflowMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<WorkflowMessageDetails>(
    WORKFLOW_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details;
      if (!details) {
        return new Text(
          typeof message.content === "string" ? message.content : "(workflow update)",
          0,
          0,
        );
      }

      const { snapshot } = details;
      const color = statusColor(snapshot.status);
      const header = [
        theme.fg(color, statusIcon(snapshot.status)),
        theme.fg("toolTitle", theme.bold(" workflow ")),
        theme.fg("accent", snapshot.workflowName),
        theme.fg("muted", ` ${eventLabel(details.event)}`),
      ].join("");

      const stepLine =
        snapshot.presentation.currentStepNumber && snapshot.presentation.currentStepAgent
          ? `Step ${snapshot.presentation.currentStepNumber}/${snapshot.presentation.steps.length}: ${snapshot.presentation.currentStepAgent}`
          : undefined;
      const progress = snapshot.presentation.lastProgress.trim();

      if (!expanded) {
        const lines = [header];
        if (stepLine) lines.push(theme.fg("dim", stepLine));
        lines.push(
          theme.fg(
            "muted",
            `ready:${snapshot.presentation.summary.readyWorkItems} done:${snapshot.presentation.summary.doneWorkItems} blocked:${snapshot.presentation.summary.blockedWorkItems} blockers:${snapshot.presentation.summary.blockers} verification:${snapshot.presentation.summary.verification}`,
          ),
        );
        if (progress) lines.push(theme.fg("toolOutput", progress));
        return new Text(lines.join("\n"), 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));

      if (stepLine) {
        container.addChild(new Text(theme.fg("dim", stepLine), 0, 0));
      }

      if (snapshot.presentation.currentFocus) {
        container.addChild(
          new Text(
            theme.fg("dim", `Focus: ${snapshot.presentation.currentFocus}`),
            0,
            0,
          ),
        );
      }

      if (snapshot.presentation.topReadyWorkItem) {
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              `Top ready: ${snapshot.presentation.topReadyWorkItem}`,
            ),
            0,
            0,
          ),
        );
      }

      if (progress) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(progress, 0, 0, getMarkdownTheme()));
      }

      const lists = [
        renderList("Blockers", snapshot.presentation.blockers, theme),
        renderList("Decisions", snapshot.presentation.decisions, theme),
        renderList("Verification", snapshot.presentation.verification, theme),
        renderList("Ready Work", snapshot.presentation.readyWorkItems, theme),
        renderList("Blocked Work", snapshot.presentation.blockedWorkSummary, theme),
      ].filter((item): item is Text => Boolean(item));

      if (lists.length > 0) {
        container.addChild(new Spacer(1));
        for (const list of lists) {
          container.addChild(list);
          container.addChild(new Spacer(1));
        }
      }

      return container;
    },
  );
}
