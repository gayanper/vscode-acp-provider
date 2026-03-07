// SPDX-License-Identifier: Apache-2.0

/**
 * This file contains api types that are not yet part of public ACP protocol.
 * The following types are from API drafts
 */

/**
 * Represents the context-window + cumulative-cost payload delivered via
 * `session/update` with `sessionUpdate: "usage_update"` (ACP RFD draft).
 * The SDK does not yet include this type, so we define it locally.
 *
 * https://agentclientprotocol.com/rfds/session-usage
 */
export interface UsageUpdateNotification {
  readonly sessionUpdate: "usage_update";
  /** Tokens currently occupying the model's context window. */
  readonly used: number;
  /** Total context window capacity in tokens. */
  readonly size: number;
  /** Optional cumulative session cost (not surfaced in VS Code UI yet). */
  readonly cost?: {
    readonly amount: number;
    readonly currency: string;
  };
}

export function isUsageUpdate(update: {
  sessionUpdate: string;
}): update is UsageUpdateNotification {
  return update.sessionUpdate === "usage_update";
}
