import type { ServerManagedGithubDelivery } from "./types";
/** A persisted GitHub check, not merely an accepted audit or delivery request. */
export declare function isServerManagedGithubDelivery(value: unknown): value is ServerManagedGithubDelivery;
