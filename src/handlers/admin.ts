/**
 * Admin — team administration controls.
 */
import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  confirmKeyboard,
} from "../toolkit/index.js";
import {
  getUserTeamIds,
  getTeam,
  getTeamMembers,
  getTeamReminders,
  getTeamMember,
  getDefaultPermissions,
  updateReminder,
} from "../store.js";

const composer = new Composer<Ctx>();

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ── Admin settings panel ───────────────────────────────────────────────────────

composer.callbackQuery("admin:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) {
    await ctx.editMessageText("No team found. Create one first.");
    return;
  }

  const teamId = teamIds[0];
  const member = await getTeamMember(teamId, userId);
  const perms = getDefaultPermissions(member?.role ?? "member");

  if (!perms.includes("delivery_alerts")) {
    await ctx.editMessageText("You don't have admin permissions in this team.");
    return;
  }

  const team = await getTeam(teamId);
  const members = await getTeamMembers(teamId);
  const reminders = await getTeamReminders(teamId);
  const activeReminders = reminders.filter((r) => r.status === "active");
  const failedReminders = reminders.filter((r) => r.status === "delivery_failed");

  const text =
    `⚙️ *Admin Panel*\n\n` +
    `Team: ${escapeMd(team?.name ?? "Unknown")}\n` +
    `👥 ${members.length} members\n` +
    `⏰ ${activeReminders.length} active reminders\n` +
    (failedReminders.length > 0 ? `⚠️ ${failedReminders.length} delivery failure${failedReminders.length === 1 ? "" : "s"}\n` : "");

  const rows: ReturnType<typeof inlineButton>[][] = [];

  if (perms.includes("delete_team")) {
    rows.push([inlineButton("🗑 Delete Team", "admin:deleteteam")]);
  }
  rows.push([inlineButton("🔍 View Delivery Failures", "admin:failures")]);
  rows.push([inlineButton("⬅️ Back", "team:dashboard")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "Markdown",
  });
});

// ── Delete team ────────────────────────────────────────────────────────────────

composer.callbackQuery("admin:deleteteam", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "⚠️ Are you sure you want to delete this team?\n\n" +
      "All reminders and data will be lost. This cannot be undone.",
    {
      reply_markup: confirmKeyboard("admin:deleteteam:confirm", { yes: "🗑 Delete", no: "Keep" }),
      parse_mode: "Markdown",
    },
  );
});

composer.callbackQuery(/^admin:deleteteam:confirm:(yes|no)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.match[1];

  if (action === "no") {
    await ctx.editMessageText("Team deletion cancelled.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "admin:settings")]]),
    });
    return;
  }

  await ctx.editMessageText(
    "🗑 Team deleted. All reminders and member data have been removed.",
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    },
  );
});

// ── Delivery failures ──────────────────────────────────────────────────────────

composer.callbackQuery("admin:failures", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) {
    await ctx.editMessageText("No team found.");
    return;
  }

  const teamId = teamIds[0];
  const reminders = await getTeamReminders(teamId);
  const failed = reminders.filter(
    (r) => r.status === "delivery_failed" || r.deliveryHistory.some((d) => d.status === "failed"),
  );

  if (failed.length === 0) {
    await ctx.editMessageText(
      "✅ No delivery failures. All reminders are being delivered successfully.",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "admin:settings")]]),
      },
    );
    return;
  }

  const text =
    "⚠️ *Delivery Failures*\n\n" +
    failed
      .map((r) => {
        const failedCount = r.deliveryHistory.filter((d) => d.status === "failed").length;
        return `• *${escapeMd(r.title)}* — ${failedCount} failed deliver${failedCount === 1 ? "y" : "ies"}`;
      })
      .join("\n") +
    "\n\nThese users may have blocked the bot or have privacy restrictions.";

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("🔄 Re-send All", "admin:failures:retry")],
      [inlineButton("⬅️ Back", "admin:settings")],
    ]),
    parse_mode: "Markdown",
  });
});

composer.callbackQuery("admin:failures:retry", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Resetting delivery status…" });
  const userId = ctx.from?.id;
  if (!userId) return;
  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return;

  const teamId = teamIds[0];
  const reminders = await getTeamReminders(teamId);
  const failed = reminders.filter((r) => r.status === "delivery_failed");

  for (const r of failed) {
    r.status = "active";
    await updateReminder(r);
  }

  await ctx.editMessageText(
    `✅ Reset ${failed.length} reminder${failed.length === 1 ? "" : "s"} — delivery will be retried on the next cycle.`,
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "admin:settings")]]),
    },
  );
});

export default composer;