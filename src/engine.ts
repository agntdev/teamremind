/**
 * Reminder delivery engine — runs during bot.start() to find due reminders
 * and DM assignees. Also provides a manual trigger for /start.
 *
 * The engine wraps every DM in a try/catch that tolerates a 403 (user blocked /
 * never started the bot) without aborting the rest of the batch.
 */

import type { Bot, Context, SessionFlavor } from "grammy";
import type { Reminder } from "./store.js";
import { getStore } from "./store.js";
import { inlineButton, inlineKeyboard } from "./toolkit/index.js";
import { nowMs } from "./clock.js";

/** Interval (ms) between due-reminder checks. */
const CHECK_INTERVAL = 60_000; // 1 minute

let _interval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the delivery loop. Call once during bot.start().
 * Checks for due reminders every CHECK_INTERVAL ms.
 */
export function startDeliveryEngine<S extends object>(bot: Bot<Context & SessionFlavor<S>>): void {
  if (_interval) return; // already started
  _interval = setInterval(() => deliverDueReminders(bot), CHECK_INTERVAL);
  // Fire immediately on start
  deliverDueReminders(bot).catch((err) => console.error("[engine] initial delivery check failed:", err));
}

/** Stop the delivery loop (for tests / shutdown). */
export function stopDeliveryEngine(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Find all due reminders and attempt delivery. Called on a timer AND
 * can be called manually (e.g. after /start for immediate check).
 */
export async function deliverDueReminders<S extends object>(bot: Bot<Context & SessionFlavor<S>>): Promise<void> {
  const store = getStore();
  const now = nowMs();

  const due = await store.findDueReminders();
  const active = due.filter((r) => r.status === "active");

  for (const reminder of active) {
    await deliverReminder(bot, reminder);
  }
}

/**
 * Deliver a single reminder to its assignee.
 * Tolerates 403 (user blocked / never started the bot).
 * Records delivery status in the reminder's history.
 */
async function deliverReminder<S extends object>(bot: Bot<Context & SessionFlavor<S>>, reminder: Reminder): Promise<void> {
  const store = getStore();

  const text =
    `⏰ Reminder: **${reminder.title}**\n` +
    (reminder.description ? `\n${reminder.description}\n` : "") +
    `\nSchedule: ${reminder.schedule_type}`;

  const kb = inlineKeyboard([
    [inlineButton("✅ Mark Done", `reminder:complete:${reminder.id}`)],
    [inlineButton("⏰ Snooze 15m", `reminder:snooze:${reminder.id}:15`)],
    [inlineButton("⏰ Snooze 30m", `reminder:snooze:${reminder.id}:30`)],
  ]);

  try {
    await bot.api.sendMessage(reminder.assignee_id, text, {
      reply_markup: kb,
      parse_mode: "HTML",
    });
    await store.recordDelivery(reminder.id, "sent");
  } catch (err: unknown) {
    const isBlocked = is403Error(err);
    await store.recordDelivery(reminder.id, "failed", isBlocked ? "user_blocked" : String(err));

    // Notify creator if persistent failures
    if ((reminder.consecutive_failures ?? 0) >= 2) {
      try {
        const creatorMsg =
          `⚠️ Delivery failed for **${reminder.title}**\n` +
          `Assignee (ID: ${reminder.assignee_id}) may have blocked the bot or left Telegram.\n` +
          `Failure count: ${(reminder.consecutive_failures ?? 0) + 1}`;

        await bot.api.sendMessage(reminder.creator_id, creatorMsg, { parse_mode: "HTML" });
      } catch {
        // Creator might have blocked too — swallow silently
      }
    }
  }

  // Advance recurring reminders
  if (reminder.status === "active" && reminder.interval_minutes > 0 && reminder.next_run) {
    const nextRun = new Date(nowMs() + reminder.interval_minutes * 60 * 1000);
    reminder.next_run = nextRun.toISOString();
    await store.updateReminder(reminder);
  } else if (reminder.status === "active" && reminder.interval_minutes === 0) {
    // One-time reminder: mark as completed after delivery
    // But only if it was actually delivered (not failed)
    const lastDelivery = reminder.delivery_history[reminder.delivery_history.length - 1];
    if (lastDelivery && lastDelivery.status !== "failed") {
      reminder.status = "completed";
      await store.updateReminder(reminder);
    }
  }
}

/** Check if an error is a Telegram 403 (user blocked / not started). */
function is403Error(err: unknown): boolean {
  const s = String(err);
  return s.includes("403") || s.includes("bot was blocked") || s.includes("Forbidden");
}