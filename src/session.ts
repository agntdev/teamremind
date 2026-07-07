/**
 * Shared helpers for multi-step flows — session step types and flow-data
 * field names, kept in one place so every handler imports from here.
 */

import type { Ctx } from "./bot.js";

/** All possible wizard steps across features. */
export type FlowStep =
  // Team creation
  | "team:awaiting_name"
  | "team:awaiting_tz"
  // Invite join
  | "join:awaiting_code"
  // Reminder creation
  | "remind:awaiting_title"
  | "remind:awaiting_description"
  | "remind:awaiting_assignee"
  | "remind:awaiting_schedule"
  | "remind:awaiting_interval"
  | "remind:awaiting_first_run"
  | "remind:confirm"
  // Snooze
  | "snooze:awaiting_minutes"
  | "idle";

/** Convenience: reset a flow to idle. */
export function resetFlow(ctx: Ctx): void {
  ctx.session.step = "idle";
  ctx.session.teamName = undefined;
  ctx.session.teamTimezone = undefined;
  ctx.session.remindTitle = undefined;
  ctx.session.remindAssigneeId = undefined;
  ctx.session.remindScheduleType = undefined;
  ctx.session.remindInterval = undefined;
  ctx.session.remindTimezone = undefined;
  ctx.session.remindDescription = undefined;
  ctx.session.inviteCode = undefined;
}

/** Common timezones for the timezone picker. */
export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];