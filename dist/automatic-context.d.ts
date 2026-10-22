import type { RunError } from "./types";
export declare const AUTO_CONTEXT_FAILURE_CODES: readonly ["auto_context_budget_exhausted", "auto_context_timeout", "auto_context_invalid_plan", "auto_context_provider_error", "auto_context_configuration_error"];
export declare function formatRunFailure(failure: RunError | null): string;
export declare function formatProgressPhase(phase: string): string;
