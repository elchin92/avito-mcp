import type { Config } from '../config.js';
import type { ToolRisk } from './tool-factory.js';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Decides whether a tool with the given risk should be registered for the current server.
 *
 * Evaluation order (matches the v0.4.0 contract):
 *   1. `sensitive` — auth tools and similar are hidden by default. They are enabled
 *      only via AVITO_MCP_EXPOSE_AUTH_TOOLS=1. Return immediately if there is no opt-in.
 *   2. `denyTools` — deny always wins over allow.
 *   3. `allowTools` — if the list is non-empty and the name is not in it, reject.
 *   4. `mode`:
 *      - `read_only`   → allows only risk='read' (sensitive already filtered out above)
 *      - `guarded`     → allows 'read' and 'write'; blocks 'money' and 'public'
 *      - `full_access` → allows everything (default)
 *
 * Hiding happens at the tool registration stage (in `defineTool` and, for
 * custom tools, via `server.registerTool`). A blocked tool is not visible to the
 * agent in `tools/list` — this is stronger than a runtime block.
 *
 * The confirmation flow is a separate layer on top of this policy, in `tool-factory.ts`.
 */
export function evaluatePolicy(toolName: string, risk: ToolRisk, cfg: Config): PolicyDecision {
  if (risk === 'sensitive' && !cfg.exposeAuthTools) {
    return {
      allowed: false,
      reason: `risk=sensitive hidden by default — set AVITO_MCP_EXPOSE_AUTH_TOOLS=1 to expose`,
    };
  }
  if (cfg.denyTools.includes(toolName)) {
    return { allowed: false, reason: `tool is in AVITO_MCP_DENY_TOOLS` };
  }
  if (cfg.allowTools.length > 0 && !cfg.allowTools.includes(toolName)) {
    return { allowed: false, reason: `tool is not in AVITO_MCP_ALLOW_TOOLS allowlist` };
  }
  if (cfg.mode === 'read_only' && risk !== 'read') {
    return { allowed: false, reason: `AVITO_MCP_MODE=read_only blocks risk=${risk}` };
  }
  if (cfg.mode === 'guarded' && (risk === 'money' || risk === 'public')) {
    return { allowed: false, reason: `AVITO_MCP_MODE=guarded blocks risk=${risk}` };
  }
  return { allowed: true };
}

/**
 * Decides whether a tool with the given risk requires confirmation via meta_confirm_action.
 * Applied at runtime (after the policy pass). Sensitive does not require it — it is already
 * behind a strict opt-in, so an additional confirm there makes no sense.
 */
export function requiresConfirmation(risk: ToolRisk, cfg: Config): boolean {
  if (cfg.confirmationMode === 'off') return false;
  if (cfg.confirmationMode === 'money_public') {
    return risk === 'money' || risk === 'public';
  }
  // all_destructive
  return risk === 'money' || risk === 'public' || risk === 'write';
}
