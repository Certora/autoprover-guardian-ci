import type { ActionConfig, RunRequest } from "./types";
export declare function buildRunRequest(config: ActionConfig): RunRequest;
export declare function run(): Promise<void>;
