import type { RunError } from "./types";

export const AUTO_CONTEXT_FAILURE_CODES = [
  "auto_context_budget_exhausted",
  "auto_context_timeout",
  "auto_context_invalid_plan",
  "auto_context_provider_error",
  "auto_context_configuration_error",
] as const;

export function formatRunFailure(failure: RunError | null): string {
  if (!failure) return "Unknown error";
  if (!(AUTO_CONTEXT_FAILURE_CODES as readonly string[]).includes(failure.code)) {
    return failure.detail;
  }
  const guidance = failure.code === "auto_context_configuration_error"
    ? "Ask your administrator to correct the AutoContext configuration, then explicitly rerun the GitHub workflow."
    : failure.code === "auto_context_budget_exhausted" || failure.code === "auto_context_invalid_plan"
      ? "Review the audit scope or supply explicit context, then explicitly rerun the GitHub workflow."
      : "Explicitly rerun the GitHub workflow when you want to try again.";
  return `[${failure.code}] ${failure.detail} ${guidance} Guardian will not automatically relaunch this failed run.`;
}

export function formatProgressPhase(phase: string): string {
  return phase === "planning_context" || phase === "_11_context_preparation"
    ? "Planning context"
    : phase;
}
