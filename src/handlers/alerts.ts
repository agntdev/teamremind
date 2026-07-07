import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

registerMainMenuItem({ label: "🔔 My Alerts", data: "alerts:view", order: 40 });

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// View delivery failure alerts (admin-only)
// ---------------------------------------------------------------------------

composer.callbackQuery("alerts:view", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = (await import("../store.js")).getStore();
  const user = await store.getUser(ctx.from!.id);

  if (!user || user.role !== "admin") {
    await ctx.editMessageText(
      "Only team admins can view delivery alerts.",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
    return;
  }

  const failing = await store.findFailingReminders(3);

  const teamFailures = failing.filter((f) => f.reminder.team_id === user.team_id);

  if (teamFailures.length === 0) {
    await ctx.editMessageText(
      "✅ No delivery failures. All reminders are being sent successfully.",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
    return;
  }

  const lines = teamFailures.map(
    (f) =>
      `• **${f.reminder.title}** — ${(f.reminder.consecutive_failures ?? 0)} failed attempt(s)\n` +
      `  Assignee: ${f.assignee?.display_name ?? "unknown"}`,
  );

  const text =
    `⚠️ Delivery Failure Alerts\n\n` +
    `The following reminders have ${failing.length} persistent failure(s):\n\n` +
    lines.join("\n\n");

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("📋 My Reminders", "reminders:list")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

export default composer;