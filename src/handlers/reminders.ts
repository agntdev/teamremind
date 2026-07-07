import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { ScheduleType } from "../store.js";
import { nowMs } from "../clock.js";

registerMainMenuItem({ label: "⏰ Remind", data: "remind:create", order: 10 });

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// Entry: callback or /remind create
// ---------------------------------------------------------------------------

composer.callbackQuery("remind:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);

  if (!user) {
    await ctx.editMessageText(
      "You need to be in a team first. Tap 👥 My Team to create or join one.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("👥 My Team", "team:view")],
        ]),
      },
    );
    return;
  }

  ctx.session.step = "remind:awaiting_title";
  ctx.session.remindFirstRun = undefined;
  await ctx.editMessageText(
    "Let's create a reminder.\n\nSend me the title (what's this reminder about?).",
    {
      reply_markup: inlineKeyboard([[inlineButton("Cancel", "remind:cancel")]]),
    },
  );
});

// ---------------------------------------------------------------------------
// Step: Title
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_title") return next();

  const title = ctx.message.text.trim();
  if (title.length < 2 || title.length > 200) {
    await ctx.reply("Title should be between 2 and 200 characters. Try again.");
    return;
  }

  ctx.session.remindTitle = title;
  ctx.session.step = "remind:awaiting_description";

  await ctx.reply(
    `Got it: **${title}**.\n\nNow send me a description (or skip).`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Skip", "remind:skip_desc")],
        [inlineButton("Cancel", "remind:cancel")],
      ]),
    },
  );
});

composer.callbackQuery("remind:skip_desc", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.remindDescription = "";
  await proceedToAssignee(ctx);
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_description") return next();

  ctx.session.remindDescription = ctx.message.text.trim();
  await proceedToAssignee(ctx);
});

async function proceedToAssignee(ctx: Ctx): Promise<void> {
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user) {
    await ctx.reply("Team not found. Start again.");
    ctx.session.step = "idle";
    return;
  }

  const members = await store.getTeamMembers(user.team_id);
  const others = members.filter((m) => m.telegram_id !== ctx.from!.id);

  if (others.length === 0) {
    ctx.session.remindAssigneeId = ctx.from!.id;
    await proceedToSchedule(ctx);
    return;
  }

  ctx.session.step = "remind:awaiting_assignee";
  const buttons = others.map((m) => [
    inlineButton(m.display_name, `remind:assign:${m.telegram_id}`),
  ]);
  buttons.push([inlineButton("Myself", `remind:assign:${ctx.from!.id}`)]);
  buttons.push([inlineButton("Cancel", "remind:cancel")]);

  await ctx.reply("Who should this reminder be for?", {
    reply_markup: inlineKeyboard(buttons),
  });
}

// ---------------------------------------------------------------------------
// Step: Assignee
// ---------------------------------------------------------------------------

composer.callbackQuery(/^remind:assign:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const assigneeId = parseInt(ctx.callbackQuery.data.split(":")[2], 10);
  ctx.session.remindAssigneeId = assigneeId;
  await proceedToSchedule(ctx);
});

async function proceedToSchedule(ctx: Ctx): Promise<void> {
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user) {
    await ctx.reply("Team not found. Start again.");
    ctx.session.step = "idle";
    return;
  }

  ctx.session.remindTimezone = user.preferred_timezone;
  ctx.session.step = "remind:awaiting_schedule";

  const text = "How often should this repeat?\n\nPick a schedule type:";
  const kb = inlineKeyboard([
    [inlineButton("⏰ Once", "sched:once")],
    [inlineButton("📅 Daily", "sched:daily")],
    [inlineButton("📅 Weekdays", "sched:weekdays")],
    [inlineButton("📅 Weekly", "sched:weekly")],
    [inlineButton("📅 Monthly", "sched:monthly")],
    [inlineButton("Cancel", "remind:cancel")],
  ]);

  if (ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(text, { reply_markup: kb });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

// ---------------------------------------------------------------------------
// Step: Schedule type
// ---------------------------------------------------------------------------

composer.callbackQuery(/^sched:(once|daily|weekdays|weekly|monthly)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const type = ctx.match![1] as ScheduleType;
  ctx.session.remindScheduleType = type;

  if (type === "once") {
    ctx.session.remindInterval = 0;
    ctx.session.step = "remind:awaiting_first_run";
    await ctx.editMessageText(
      "Send me the first run time.\n\nUse the format: `YYYY-MM-DD HH:MM` (24-hour, in your team's timezone).\n\nExample: `2026-07-08 14:30`",
      {
        reply_markup: inlineKeyboard([[inlineButton("Cancel", "remind:cancel")]]),
      },
    );
  } else {
    ctx.session.step = "remind:awaiting_interval";
    await ctx.editMessageText(
      "How many minutes between each reminder?\n\n" +
      "For example: 60 for hourly, 1440 for daily, 10080 for weekly.",
      {
        reply_markup: inlineKeyboard([[inlineButton("Cancel", "remind:cancel")]]),
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Step: Interval input
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_interval") return next();

  const input = ctx.message.text.trim();
  const minutes = parseInt(input, 10);
  if (isNaN(minutes) || minutes < 1 || minutes > 525600) {
    await ctx.reply("Enter a number between 1 and 525600 minutes (1 year). Try again.");
    return;
  }

  ctx.session.remindInterval = minutes;
  ctx.session.step = "remind:awaiting_first_run";

  await ctx.reply(
    "Send me the first run time.\n\nUse the format: `YYYY-MM-DD HH:MM` (24-hour, in your team's timezone).\n\nExample: `2026-07-08 14:30`",
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", "remind:cancel")]]) },
  );
});

// ---------------------------------------------------------------------------
// Step: First run time
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "remind:awaiting_first_run") return next();

  const input = ctx.message.text.trim();
  const parsed = parseDateTime(input);

  if (!parsed) {
    await ctx.reply(
      "I couldn't understand that time. Use the format `YYYY-MM-DD HH:MM` (24-hour).\n\nExample: `2026-07-08 14:30`",
    );
    return;
  }

  if (parsed.getTime() <= nowMs()) {
    await ctx.reply("The time must be in the future. Try again.");
    return;
  }

  ctx.session.remindFirstRun = parsed.toISOString();
  await showConfirm(ctx);
});

async function showConfirm(ctx: Ctx): Promise<void> {
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user) {
    await ctx.reply("Team not found. Start again.");
    ctx.session.step = "idle";
    return;
  }

  const title = ctx.session.remindTitle!;
  const assigneeId = ctx.session.remindAssigneeId!;
  const scheduleType = ctx.session.remindScheduleType!;
  const interval = ctx.session.remindInterval ?? 0;
  const description = ctx.session.remindDescription ?? "";

  let assigneeName = "Yourself";
  if (assigneeId !== ctx.from!.id) {
    const a = await store.getUser(assigneeId);
    if (a) assigneeName = a.display_name;
  }

  const descLine = description ? `\nDescription: ${description}` : "";
  const intervalLine = interval > 0 ? `\nEvery ${interval} minutes` : "";
  const firstRunDate = ctx.session.remindFirstRun
    ? new Date(ctx.session.remindFirstRun).toLocaleString()
    : "immediately";

  const text =
    `📋 Reminder Summary\n\n` +
    `Title: **${title}**${descLine}\n` +
    `For: ${assigneeName}\n` +
    `Schedule: ${scheduleType}${intervalLine}\n` +
    `First run: ${firstRunDate}\n\n` +
    `Tap Confirm to schedule it.`;

  ctx.session.step = "remind:confirm";
  await ctx.reply(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("✅ Confirm", "remind:confirm_create")],
      [inlineButton("Cancel", "remind:cancel")],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Step: Confirm creation
// ---------------------------------------------------------------------------

composer.callbackQuery("remind:confirm_create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();

  const title = ctx.session.remindTitle;
  const assigneeId = ctx.session.remindAssigneeId;
  const scheduleType = ctx.session.remindScheduleType as ScheduleType | undefined;
  const interval = ctx.session.remindInterval ?? 0;
  const description = ctx.session.remindDescription ?? "";
  const firstRun = ctx.session.remindFirstRun;
  const user = await store.getUser(ctx.from!.id);

  if (!title || !assigneeId || !scheduleType || !user) {
    await ctx.editMessageText("Something went wrong — start again.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    });
    ctx.session.step = "idle";
    return;
  }

  const reminder = await store.createReminder({
    title,
    description,
    assignee_id: assigneeId,
    creator_id: ctx.from!.id,
    team_id: user.team_id,
    schedule_type: scheduleType,
    interval_minutes: interval,
    timezone: user.preferred_timezone,
    status: "active",
    next_run: firstRun ?? new Date(Date.now() + 60000).toISOString(),
  });

  ctx.session.step = "idle";

  const text =
    `✅ Reminder created!\n\n**${reminder.title}**\n` +
    `Schedule: ${reminder.schedule_type}\n` +
    `First delivery: ${reminder.next_run ? new Date(reminder.next_run).toLocaleString() : "soon"}`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

composer.callbackQuery("remind:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await ctx.editMessageText("Cancelled.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDateTime(input: string): Date | null {
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m.map(Number);
  const date = new Date(y, mo - 1, d, hh, mm, 0, 0);
  return isNaN(date.getTime()) ? null : date;
}

export default composer;