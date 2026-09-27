import type * as acp from "@agentclientprotocol/sdk";
import type { PermissionReply } from "../types.ts";

const KINDS: Record<"once" | "always" | "reject", acp.PermissionOptionKind[]> = {
  once: ["allow_once", "allow_always"],
  always: ["allow_always", "allow_once"],
  reject: ["reject_once", "reject_always"],
};

/** Turn a shorthand reply into the ACP response, picking the offered option of that kind. */
export function toPermissionResponse(request: acp.RequestPermissionRequest, reply: PermissionReply): acp.RequestPermissionResponse {
  if (typeof reply === "object") return reply;
  if (reply === "cancel") return { outcome: { outcome: "cancelled" } };
  for (const kind of KINDS[reply]) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
