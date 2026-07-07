import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  paginate,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { Reminder } from "../store.js";
import { now, nowMs } from "../clock.js";

registerMainMenuItem({ label: "📋 My Reminders", data: "reminders:list", order: 20 });

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// List reminders
// ---------------------------------------------------------------------------

composer.callbackQuery("reminders:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);

  if (!user) {
    await ctx.editMessageText(
      "You need to be in a team first. Tap 👥 My Team to create or join one.",
      { reply_markup: inlineKeyboard([[inlineButton("👥 My Team", "team:view")]]) },
    );
    return;
  }

  const all = await store.listRemindersForAssignee(ctx.from!.id);
  await renderReminderList(ctx, all, 0);
});

async function renderReminderList(ctx: Ctx, reminders: Reminder[], page: number): Promise<void> {
  const active = reminders.filter((r) => r.status === "active");
  const completed = reminders.filter((r) => r.status === "completed");

  if (active.length === 0 && completed.length === 0) {
    await ctx.editMessageText(
      "📋 No reminders yet.\n\nTap ⏰ Remind to create one.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const { pageItems, controls } = paginate(active, { page, perPage: 5, callbackPrefix: "rlist" });

  if (pageItems.length === 0 && page > 0) {
    // Wrapped past end — show first page
    await renderReminderList(ctx, reminders, 0);
    return;
  }

  const lines = pageItems.map((r, i) => {
    const status = r.next_run ? ` ⏰ ${new Date(r.next_run).toLocaleString()}` : "";
    return `${i + 1}. ${r.title}${status}`;
  });

  const totalCompleted = completed.length;
  const text =
    `📋 Active Reminders (page ${page + 1}/${Math.max(1, Math.ceil(active.length / 5))})\n\n` +
    lines.join("\n") +
    (totalCompleted > 0 ? `\n\n✅ ${totalCompleted} completed` : "");

  const buttons: ReturnType<typeof inlineButton>[][] = [];
  for (const r of pageItems) {
    buttons.push([
      inlineButton(`✅ ${r.title.slice(0, 20)}`, `reminders:done:${r.id}`),
      inlineButton(`⏰ Snooze`, `reminders:snooze:${r.id}`),
    ]);
  }

  if (controls.inline_keyboard.length > 0) {
    buttons.push(...controls.inline_keyboard);
  }
  buttons.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(buttons) });
}

// Pagination
composer.callbackQuery(/^rlist:(prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, , pageStr] = ctx.callbackQuery.data.split(":");
  const page = parseInt(pageStr, 10);
  const store = getStore();
  const all = await store.listRemindersForAssignee(ctx.from!.id);
  await renderReminderList(ctx, all, page);
});

// ---------------------------------------------------------------------------
// Mark done
// ---------------------------------------------------------------------------

composer.callbackQuery(/^reminders:done:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.callbackQuery.data.split(":")[2];
  const store = getStore();
  const reminder = await store.getReminder(reminderId);

  if (!reminder) {
    await ctx.editMessageText("That reminder no longer exists.");
    return;
  }

  if (reminder.assignee_id !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "This isn't your reminder.", show_alert: true });
    return;
  }

  reminder.status = "completed";
  await store.updateReminder(reminder);

  // Notify the creator
  if (reminder.creator_id !== ctx.from!.id) {
    await sendCreatorNotification(ctx, reminder, "completed");
  }

  await ctx.editMessageText(
    `✅ **${reminder.title}** marked as done!`,
    { reply_markup: inlineKeyboard([[inlineButton("📋 Back to list", "reminders:list")]]) },
  );
});

// ---------------------------------------------------------------------------
// Snooze
// ---------------------------------------------------------------------------

composer.callbackQuery(/^reminders:snooze:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const reminderId = ctx.callbackQuery.data.split(":")[2];
  const store = getStore();
  const reminder = await store.getReminder(reminderId);

  if (!reminder) {
    await ctx.editMessageText("That reminder no longer exists.");
    return;
  }

  if (reminder.assignee_id !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "This isn't your reminder.", show_alert: true });
    return;
  }

  ctx.session.step = "snooze:awaiting_minutes";
  ctx.session.remindSnoozeReminderId = reminderId;

  await ctx.editMessageText(
    `⏰ How many minutes to snooze **${reminder.title}**?\n\n` +
    "Send a number (5, 15, 30, 60, etc.).",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("5 min", `snooze:set:${reminderId}:5`)],
        [inlineButton("15 min", `snooze:set:${reminderId}:15`)],
        [inlineButton("30 min", `snooze:set:${reminderId}:30`)],
        [inlineButton("60 min", `snooze:set:${reminderId}:60`)],
        [inlineButton("Cancel", "remind:cancel")],
      ]),
    },
  );
});

// Preset snooze buttons
composer.callbackQuery(/^snooze:set:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  const reminderId = parts[2];
  const minutes = parseInt(parts[3], 10);

  await applySnooze(ctx, reminderId, minutes);
});

// Custom snooze text input
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "snooze:awaiting_minutes") return next();

  const input = ctx.message.text.trim();
  const minutes = parseInt(input, 10);
  if (isNaN(minutes) || minutes < 1 || minutes > 43200) {
    await ctx.reply("Enter a number between 1 and 43200 (30 days). Try again.");
    return;
  }

  const reminderId = ctx.session.remindSnoozeReminderId;
  if (!reminderId) {
    await ctx.reply("Couldn't find the reminder to snooze. Try again from the list.");
    ctx.session.step = "idle";
    return;
  }

  await applySnooze(ctx, reminderId, minutes);
});

async function applySnooze(ctx: Ctx, reminderId: string, minutes: number): Promise<void> {
  const store = getStore();
  const reminder = await store.getReminder(reminderId);
  if (!reminder) {
    await ctx.editMessageText("That reminder no longer exists.");
    return;
  }

  const newRun = new Date(nowMs() + minutes * 60 * 1000);
  reminder.next_run = newRun.toISOString();
  reminder.consecutive_failures = 0;
  await store.updateReminder(reminder);

  await ctx.editMessageText(
    `⏰ **${reminder.title}** snoozed for ${minutes} minutes.\nNext reminder: ${newRun.toLocaleString()}.`,
    { reply_markup: inlineKeyboard([[inlineButton("📋 Back to list", "reminders:list")]]) },
  );
}

// ---------------------------------------------------------------------------
// Creator notification helper
// ---------------------------------------------------------------------------

export async function sendCreatorNotification(
  ctx: Ctx,
  reminder: Reminder,
  action: "completed" | "failed",
): Promise<void> {
  const store = getStore();
  const assignee = await store.getUser(reminder.assignee_id);

  if (!assignee) return;

  const text =
    action === "completed"
      ? `✅ **${reminder.title}** was marked done by ${assignee.display_name}.`
      : `⚠️ Delivery failed for **${reminder.title}** to ${assignee.display_name}. Check the team settings.`;

  try {
    await ctx.api.sendMessage(reminder.creator_id, text);
  } catch {
    // User may have blocked the bot — swallow silently
  }
}

export default composer;