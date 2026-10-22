/**
 * product-brief.js - canonical PRODUCT_BRIEF (single copy).
 *
 * FICTIONAL PLACEHOLDER: FlowSmith is the seeded demo product (renamed
 * from the NimbusDesk placeholder, Task 20-a, user direction: the demo
 * product is now "FlowSmith"). The user supplies the real product copy
 * later and replaces ONLY the string below (code-standards.md constants
 * table row PRODUCT_BRIEF). The fiction is derived strictly from the
 * seeded demo copy in public/index.html so the bot can never contradict
 * the UI:
 *   - AI services company for business owners; builds AI automations
 *     (lead follow-up, scheduling, reporting, support workflows)
 *   - automations connect to the tools a business already uses
 *   - every engagement starts with a short free scoping call
 *   - a first automation goes live in about one week
 *   - monthly plans scale with the number of automations
 *
 * Consumers: the voice-service sales prompt builder (pure import, same
 * boundary posture as server/lib/constants.js) and the summary prompt
 * path (the summary uses the conversation's own transcript, not this
 * brief). Plain English, ASCII only.
 */

export const PRODUCT_BRIEF =
  "FlowSmith is an AI services company for business owners. " +
  "It builds AI automations that make daily work quick and easy to " +
  "organize - lead follow-up, scheduling, reporting, and support " +
  "workflows connected to the tools a business already uses. Every " +
  "engagement starts with a short free scoping call. A first automation " +
  "goes live in about one week. Monthly plans scale with the number of " +
  "automations.";
