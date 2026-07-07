import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, inlineKeyboard, inlineButton } from "../toolkit/index.js";
import { now } from "../clock.js";
import {
  getTeam,
  addTeamMember,
  getUserTeamIds,
  addUserTeamMapping,
  type TeamMember,
} from "../store.js";

const composer = new Composer<Ctx>();

const WELCOME = "👋 Welcome! Tap a button below to get started.";

composer.command("start", async (ctx) => {
  // Check for invite deep-link: t.me/bot?start=join_<teamId>
  const text = ctx.message?.text ?? "";
  const payload = text.startsWith("/start ") ? text.slice(7).trim() : "";
  if (payload && payload.startsWith("join_")) {
    const teamId = payload.slice(5);
    await handleInvite(ctx, teamId);
    return;
  }

  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

async function handleInvite(ctx: Ctx, teamId: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify you. Please try again.");
    return;
  }

  const team = await getTeam(teamId);
  if (!team) {
    await ctx.reply(
      "This invite link is invalid or the team no longer exists. " +
        "Ask your admin for a new invite.",
    );
    return;
  }

  const existingTeamIds = await getUserTeamIds(userId);
  if (existingTeamIds.includes(teamId)) {
    await ctx.reply(
      `You're already a member of **${team.name}**! Tap below to open your dashboard.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("👥 My Teams", "team:dashboard")],
        ]),
        parse_mode: "Markdown",
      },
    );
    return;
  }

  const member: TeamMember = {
    telegramId: userId,
    teamId,
    displayName: ctx.from?.first_name ?? `User${userId}`,
    role: "member",
    timezone: team.timezone,
    joinedAt: now().getTime(),
    optedIn: true,
  };

  await addTeamMember(member);
  await addUserTeamMapping(userId, teamId);

  await ctx.reply(
    `🎉 You've joined **${team.name}**!\n\n` +
      `Your timezone: ${team.timezone}\n` +
      `Role: Member\n\n` +
      `You'll start receiving team reminders. Tap below to open your dashboard.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("👥 My Teams", "team:dashboard")],
        [inlineButton("⬅️ Main Menu", "menu:main")],
      ]),
      parse_mode: "Markdown",
    },
  );
}

composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

export default composer;