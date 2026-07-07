/**
 * Reminders — creation, listing, completion, snooze, delivery.
 */
import { randomUUID } from "node:crypto";
import { Composer } from "grammy";
import { now } from "../clock.js";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  paginate,
} from "../toolkit/index.js";
import {
  createReminder,
  getReminder,
  updateReminder,
  getRemindersForAssignee,
  getUserTeamIds,
  getTeam,
  getTeamMember,
  getTeamMemberIds,
  getDefaultPermissions,
  type Reminder,
} from "../store.js";

const composer = new Composer<Ctx>();

// ── Helpers ────────────────────────────────────────────────────────────────────

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function scheduleLabel(s: string): string {
  switch (s) {
    case "once": return "One-time";
    case "daily": return "Daily";
    case "weekly": return "Weekly";
    case "monthly": return "Monthly";
    case "weekdays": return "Weekdays";
    default: return s;
  }
}

function reminderStatusEmoji(status: string): string {
  switch (status) {
    case "active": return "🟢";
    case "completed": return "✅";
    case "cancelled": return "❌";
    case "delivery_failed": return "⚠️";
    default: return "❓";
  }
}

function formatReminderText(r: Reminder, nowMs: number): string {
  const lines: string[] = [
    `${reminderStatusEmoji(r.status)} *${escapeMd(r.title)}*`,
    r.description ? `📝 ${escapeMd(r.description)}` : null,
    `📅 ${scheduleLabel(r.scheduleType)}`,
  ].filter(Boolean) as string[];

  if (r.nextRun > nowMs) {
    const d = new Date(r.nextRun);
    lines.push(`⏰ Next: ${d.toLocaleString("en-US", { timeZone: r.timezone, hour: "2-digit", minute: "2-digit", month: "short", day: "numeric", year: "numeric" })}`);
  } else {
    lines.push("⏰ Due now");
  }

  if (r.snoozeUntil && r.snoozeUntil > nowMs) {
    const d = new Date(r.snoozeUntil);
    lines.push(`💤 Snoozed until ${d.toLocaleString("en-US", { timeZone: r.timezone, hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}`);
  }

  const deliveries = r.deliveryHistory.length;
  if (deliveries > 0) {
    const failed = r.deliveryHistory.filter((e) => e.status === "failed").length;
    lines.push(`📬 ${deliveries} deliver${deliveries === 1 ? "y" : "ies"}${failed > 0 ? ` (${failed} failed)` : ""}`);
  }

  return lines.join("\n");
}

function formatReminderShort(r: Reminder): string {
  const d = new Date(r.nextRun);
  const timeStr = d.toLocaleString("en-US", {
    timeZone: r.timezone, hour: "2-digit", minute: "2-digit", month: "short", day: "numeric",
  });
  return `${reminderStatusEmoji(r.status)} *${escapeMd(r.title)}* — ${timeStr}`;
}

// ── Create flow ────────────────────────────────────────────────────────────────

composer.callbackQuery("remind:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) {
    await ctx.editMessageText("You need a team first! Create one from the dashboard.");
    return;
  }

  ctx.session.step = "remind:awaiting_title";
  ctx.session.remAssigneeId = undefined;
  ctx.session.remSchedule = undefined;

  await ctx.editMessageText(
    'Let\'s create a reminder!\n\nWhat should it be called? (e.g. "Team standup", "Review PRs")',
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", "remind:create:cancel")]]) },
  );
});

composer.callbackQuery("remind:create:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = undefined;
  ctx.session.remTitle = undefined;
  ctx.session.remAssigneeId = undefined;
  ctx.session.remSchedule = undefined;
  await ctx.editMessageText("Reminder creation cancelled.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "team:dashboard")]]),
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_title") return next();

  const title = ctx.message.text.trim();
  if (title.length < 1 || title.length > 200) {
    await ctx.reply("Title should be between 1 and 200 characters. Try again.");
    return;
  }

  ctx.session.remTitle = title;
  ctx.session.step = "remind:awaiting_assignee";

  const userId = ctx.from?.id;
  if (!userId) return;
  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return;

  const teamId = teamIds[0];
  const mIds = await getTeamMemberIds(teamId);
  const rows: ReturnType<typeof inlineButton>[][] = [];

  for (const mid of mIds) {
    const m = await getTeamMember(teamId, mid);
    if (m) {
      rows.push([inlineButton(m.displayName, `remind:assign:${mid}`)]);
    }
  }

  rows.push([inlineButton("Skip — I'll type a name", "remind:assign:type")]);
  rows.push([inlineButton("Cancel", "remind:create:cancel")]);

  await ctx.reply(
    `Reminder: **${escapeMd(title)}**\n\nWho should this be assigned to? Pick a member below or type a name.`,
    { reply_markup: inlineKeyboard(rows), parse_mode: "Markdown" },
  );
});

composer.callbackQuery(/^remind:assign:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.remAssigneeId = parseInt(ctx.match[1], 10);
  await askScheduleType(ctx);
});

composer.callbackQuery("remind:assign:type", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "remind:awaiting_assignee_name";
  await ctx.editMessageText("Type the name of the person to assign this to:");
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_assignee_name") return next();
  const userId = ctx.from?.id;
  if (!userId) return;
  ctx.session.remAssigneeId = userId;
  ctx.session.step = undefined;
  await askScheduleType(ctx);
});

async function askScheduleType(ctx: Ctx): Promise<void> {
  ctx.session.step = "remind:awaiting_schedule";
  const text = `Reminder: **${escapeMd(ctx.session.remTitle ?? "Reminder")}**\n\nHow often should it repeat?`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("One-time", "remind:schedule:once")],
      [inlineButton("Daily", "remind:schedule:daily")],
      [inlineButton("Weekly", "remind:schedule:weekly")],
      [inlineButton("Weekdays (Mon-Fri)", "remind:schedule:weekdays")],
      [inlineButton("Monthly", "remind:schedule:monthly")],
      [inlineButton("Cancel", "remind:create:cancel")],
    ]),
    parse_mode: "Markdown",
  });
}

composer.callbackQuery(/^remind:schedule:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const scheduleType = ctx.match[1] as Reminder["scheduleType"];
  ctx.session.remSchedule = scheduleType;
  ctx.session.step = "remind:awaiting_time";

  await ctx.editMessageText(
    "When should it first run? Type a date and time in your team's timezone.\n\n" +
      "Format: `HH:MM` (today), or `YYYY-MM-DD HH:MM`\n\n" +
      "Example: `14:30` or `2026-07-10 09:00`",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔘 Now (start immediately)", "remind:time:now")],
        [inlineButton("Cancel", "remind:create:cancel")],
      ]),
      parse_mode: "Markdown",
    },
  );
});

composer.callbackQuery("remind:time:now", async (ctx) => {
  await ctx.answerCallbackQuery();
  await finishReminder(ctx, now().getTime() + 60_000);
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_time") return next();
  const text = ctx.message.text.trim();

  const nextRun = parseTimeInput(text);
  if (nextRun === null) {
    await ctx.reply(
      "Couldn't understand that time. Try `HH:MM` (e.g. `14:30`) or `YYYY-MM-DD HH:MM` (e.g. `2026-07-10 09:00`).",
      { parse_mode: "Markdown" },
    );
    return;
  }

  await finishReminder(ctx, nextRun);
});

async function finishReminder(ctx: Ctx, nextRun: number): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return;

  const teamId = teamIds[0];
  const team = await getTeam(teamId);
  if (!team) {
    await ctx.reply("Team not found.");
    return;
  }

  const reminder: Reminder = {
    id: randomUUID().slice(0, 12),
    title: ctx.session.remTitle ?? "Untitled",
    description: "",
    assigneeId: ctx.session.remAssigneeId ?? userId,
    creatorId: userId,
    teamId,
    scheduleType: (ctx.session.remSchedule as Reminder["scheduleType"]) ?? "once",
    nextRun,
    timezone: team.timezone,
    status: "active",
    deliveryHistory: [],
    createdAt: now().getTime(),
  };

  await createReminder(reminder);

  ctx.session.step = undefined;
  ctx.session.remTitle = undefined;
  ctx.session.remAssigneeId = undefined;
  ctx.session.remSchedule = undefined;

  const d = new Date(nextRun);
  const timeStr = d.toLocaleString("en-US", {
    timeZone: team.timezone, weekday: "short", hour: "2-digit", minute: "2-digit",
    month: "short", day: "numeric", year: "numeric",
  });

  await ctx.reply(
    `✅ Reminder created!\n\n` +
      `*${escapeMd(reminder.title)}*\n` +
      `📅 ${scheduleLabel(reminder.scheduleType)} — ${timeStr}\n` +
      (reminder.assigneeId === userId ? "👤 Assigned to: You" : ""),
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 My Reminders", "remind:list")],
        [inlineButton("⬅️ Back to dashboard", "team:dashboard")],
      ]),
      parse_mode: "Markdown",
    },
  );
}

function parseTimeInput(text: string): number | null {
  const nowMs = now().getTime();

  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const d = new Date(nowMs);
    d.setHours(h, m, 0, 0);
    if (d.getTime() < nowMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/.exec(text);
  if (dateMatch) {
    const [, Y, M, D, h, m] = dateMatch.map(Number);
    const d = new Date(Y, M - 1, D, h, m, 0, 0);
    if (isNaN(d.getTime())) return null;
    if (d.getTime() < nowMs) return null;
    return d.getTime();
  }

  return null;
}

// ── Reminder list ──────────────────────────────────────────────────────────────

composer.callbackQuery("remind:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const reminders = (await getRemindersForAssignee(userId))
    .filter((r) => r.status === "active" || r.status === "completed")
    .sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (a.status !== "active" && b.status === "active") return 1;
      return a.nextRun - b.nextRun;
    });

  if (reminders.length === 0) {
    await ctx.editMessageText(
      "No reminders yet — tap ➕ Create Reminder to add one.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("➕ Create Reminder", "remind:create")],
          [inlineButton("⬅️ Back", "team:dashboard")],
        ]),
      },
    );
    return;
  }

  const page = ctx.session.reminderListPage ?? 0;
  const { pageItems, controls, totalPages } = paginate(reminders, {
    page, perPage: 5, callbackPrefix: "rlist",
  });

  const text = `📋 *My Reminders* (page ${page + 1}/${totalPages})\n\n` +
    pageItems.map((r, i) => `${page * 5 + i + 1}. ${formatReminderShort(r)}`).join("\n");

  const rows: ReturnType<typeof inlineButton>[][] = pageItems.map((r) => [
    inlineButton(`${reminderStatusEmoji(r.status)} ${r.title.slice(0, 20)}`, `remind:show:${r.id}`),
  ]);

  if (controls.inline_keyboard.length > 0) {
    rows.push(...controls.inline_keyboard.map((row) =>
      row.map((b) => inlineButton(b.text, (b as { callback_data: string }).callback_data)),
    ));
  }

  rows.push([inlineButton("➕ Create Reminder", "remind:create")]);
  rows.push([inlineButton("⬅️ Back", "team:dashboard")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "Markdown",
  });
});

// Pagination callback
composer.callbackQuery(/^rlist:(prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[2], 10);
  ctx.session.reminderListPage = page;

  const userId = ctx.from?.id;
  if (!userId) return;
  const reminders = (await getRemindersForAssignee(userId))
    .filter((r) => r.status === "active" || r.status === "completed")
    .sort((a, b) => {
      if (a.status === "active" && b.status !== "active") return -1;
      if (a.status !== "active" && b.status === "active") return 1;
      return a.nextRun - b.nextRun;
    });

  const { pageItems, controls, totalPages } = paginate(reminders, {
    page, perPage: 5, callbackPrefix: "rlist",
  });

  const text = `📋 *My Reminders* (page ${page + 1}/${totalPages})\n\n` +
    pageItems.map((r, i) => `${page * 5 + i + 1}. ${formatReminderShort(r)}`).join("\n");

  const rows: ReturnType<typeof inlineButton>[][] = pageItems.map((r) => [
    inlineButton(`${reminderStatusEmoji(r.status)} ${r.title.slice(0, 20)}`, `remind:show:${r.id}`),
  ]);

  if (controls.inline_keyboard.length > 0) {
    rows.push(...controls.inline_keyboard.map((row) =>
      row.map((b) => inlineButton(b.text, (b as { callback_data: string }).callback_data)),
    ));
  }

  rows.push([inlineButton("➕ Create Reminder", "remind:create")]);
  rows.push([inlineButton("⬅️ Back", "team:dashboard")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "Markdown",
  });
});

// ── Show reminder ──────────────────────────────────────────────────────────────

composer.callbackQuery(/^remind:show:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  const reminder = await getReminder(id);
  if (!reminder) {
    await ctx.editMessageText("Reminder not found. It may have been deleted.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "remind:list")]]),
    });
    return;
  }

  const userId = ctx.from?.id;
  const isAssignee = userId === reminder.assigneeId;
  const isCreator = userId === reminder.creatorId;

  const text = formatReminderText(reminder, now().getTime());
  const rows: ReturnType<typeof inlineButton>[][] = [];

  if (isAssignee && reminder.status === "active") {
    rows.push([inlineButton("✅ Mark Done", `remind:complete:${reminder.id}`)]);
    rows.push([inlineButton("💤 Snooze", `remind:snooze:${reminder.id}`)]);
  }
  if (isCreator || isAssignee) {
    if (reminder.status === "active") {
      rows.push([inlineButton("Cancel", `remind:cancel:${reminder.id}`)]);
    }
  }

  rows.push([inlineButton("⬅️ Back", "remind:list")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "Markdown",
  });
});

// ── Mark complete ──────────────────────────────────────────────────────────────

composer.callbackQuery(/^remind:complete:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  const reminder = await getReminder(id);

  if (!reminder) {
    await ctx.editMessageText("Reminder not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "remind:list")]]),
    });
    return;
  }

  reminder.status = "completed";
  reminder.deliveryHistory.push({ at: now().getTime(), status: "delivered" });
  await updateReminder(reminder);

  await ctx.editMessageText(
    `✅ *${escapeMd(reminder.title)}* marked as done!`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 My Reminders", "remind:list")],
        [inlineButton("⬅️ Back to dashboard", "team:dashboard")],
      ]),
      parse_mode: "Markdown",
    },
  );

  // Notify creator
  if (reminder.creatorId !== reminder.assigneeId) {
    try {
      await ctx.api.sendMessage(
        reminder.creatorId,
        `✅ *${escapeMd(reminder.title)}* was completed by ${escapeMd(ctx.from?.first_name ?? "someone")}.`,
        { parse_mode: "Markdown" },
      );
    } catch {
      // 403 from blocked user — tolerated
    }
  }
});

// ── Snooze ─────────────────────────────────────────────────────────────────────

composer.callbackQuery(/^remind:snooze:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  const reminder = await getReminder(id);

  if (!reminder) {
    await ctx.editMessageText("Reminder not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "remind:list")]]),
    });
    return;
  }

  const text = `💤 *Snooze*: ${escapeMd(reminder.title)}\n\nFor how long?`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("5 min", `remind:snooze:set:${reminder.id}:5`), inlineButton("15 min", `remind:snooze:set:${reminder.id}:15`)],
      [inlineButton("30 min", `remind:snooze:set:${reminder.id}:30`), inlineButton("1 hour", `remind:snooze:set:${reminder.id}:60`)],
      [inlineButton("2 hours", `remind:snooze:set:${reminder.id}:120`), inlineButton("Tomorrow", `remind:snooze:set:${reminder.id}:1440`)],
      [inlineButton("Cancel", `remind:show:${reminder.id}`)],
    ]),
    parse_mode: "Markdown",
  });
});

composer.callbackQuery(/^remind:snooze:set:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  const minutes = parseInt(ctx.match[2], 10);
  const reminder = await getReminder(id);

  if (!reminder) {
    await ctx.editMessageText("Reminder not found.");
    return;
  }

  const snoozeMs = minutes * 60 * 1000;
  reminder.snoozeUntil = now().getTime() + snoozeMs;
  reminder.deliveryHistory.push({
    at: now().getTime(), status: "snoozed", reason: `${minutes} min`,
  });
  await updateReminder(reminder);

  const d = new Date(reminder.snoozeUntil);
  const timeStr = d.toLocaleString("en-US", {
    timeZone: reminder.timezone, hour: "2-digit", minute: "2-digit",
  });

  await ctx.editMessageText(
    `💤 *${escapeMd(reminder.title)}* snoozed until ${timeStr}. I'll remind you then!`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 My Reminders", "remind:list")],
        [inlineButton("⬅️ Back to dashboard", "team:dashboard")],
      ]),
      parse_mode: "Markdown",
    },
  );
});

// ── Cancel reminder ────────────────────────────────────────────────────────────

composer.callbackQuery(/^remind:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = ctx.match[1];
  const reminder = await getReminder(id);

  if (!reminder) {
    await ctx.editMessageText("Reminder not found.");
    return;
  }

  reminder.status = "cancelled";
  await updateReminder(reminder);

  await ctx.editMessageText(
    `❌ *${escapeMd(reminder.title)}* cancelled.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 My Reminders", "remind:list")],
        [inlineButton("⬅️ Back to dashboard", "team:dashboard")],
      ]),
      parse_mode: "Markdown",
    },
  );
});

export default composer;