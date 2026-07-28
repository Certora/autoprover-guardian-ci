import type { Severity } from "./types";

export const SEVERITY_ORDER: Record<Severity, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  INFO: 3,
};

export const SEVERITY_EMOJI: Record<Severity, string> = {
  HIGH: "\u{1F534}",
  MEDIUM: "\u{1F7E0}",
  LOW: "\u{1F7E1}",
  INFO: "\u{1F535}",
};

export const SEVERITY_LABEL_PREFIX = "ai-auditor:";

export const ZEUS_AUDIT_LABEL = "ai-auditor";
export const LEGACY_ZEUS_AUDIT_LABEL = "auto-prover";

// Keep the original marker so runs after the repository rename update existing
// pull-request comments instead of creating duplicates.
export const PR_COMMENT_MARKER = "<!-- zeus-guardian-ci -->";

export const DEFAULT_POLL_INTERVAL = 60;
export const DEFAULT_TIMEOUT = 120;
export const DEFAULT_MAX_ITERATIONS = 6;

export const SHA_REGEX = /^[0-9a-f]{40}$/;

export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;
export const API_REQUEST_TIMEOUT_MS = 60_000;
export const REPOSITORY_PATH_MAX = 500;
export const CONTRACT_NAME_MAX = 200;
