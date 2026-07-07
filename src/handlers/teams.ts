import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  menuKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import { COMMON_TIMEZONES, resetFlow } from "../session.js";
import { nowMs } from "../clock.js";

// Register main menu button
registerMainMenuItem({ label: "👥 My Team", data: "team:view", order: 30 });

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// Team view
// ---------------------------------------------------------------------------

composer.callbackQuery("team:view", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);

  if (!user) {
    const text =
      "👥 You're not part of a team yet.\n\n" +
      "Create a new team or join one with an invite code.";
    const kb = inlineKeyboard([
      [inlineButton("➕ Create Team", "team:create")],
      [inlineButton("🔗 Join Team", "team:join")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]);
    await ctx.editMessageText(text, { reply_markup: kb });
    return;
  }

  const team = await store.getTeam(user.team_id);
  if (!team) {
    await ctx.editMessageText("Team data not found. Tap /start to try again.");
    return;
  }

  const text =
    `👥 ${team.name}\n` +
    `Members: ${team.member_ids.length}\n` +
    `Admins: ${team.admin_ids.length}\n` +
    `Timezone: ${team.timezone}\n` +
    `Your role: ${user.role}`;

  const canManage = user.role === "admin";
  const buttons: ReturnType<typeof inlineButton>[][] = [];
  if (canManage) {
    buttons.push([inlineButton("➕ Invite Member", "team:invite")]);
    buttons.push([inlineButton("📋 Members", "team:members")]);
    buttons.push([inlineButton("🗑 Delete Team", "team:delete")]);
  } else {
    buttons.push([inlineButton("📋 Members", "team:members")]);
    buttons.push([inlineButton("Leave Team", "team:leave")]);
  }
  buttons.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(buttons) });
});

// ---------------------------------------------------------------------------
// Create team wizard
// ---------------------------------------------------------------------------

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "team:awaiting_name";

  const text = "Let's create your team!\n\nSend me the name of your team.";
  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("Cancel", "team:cancel")]]),
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "team:awaiting_name") return next();

  const name = ctx.message.text.trim();
  if (name.length < 2 || name.length > 100) {
    await ctx.reply("Team name should be between 2 and 100 characters. Try again.");
    return;
  }

  ctx.session.teamName = name;
  ctx.session.step = "team:awaiting_tz";

  const items = COMMON_TIMEZONES.map((tz) => ({ text: tz, data: `team:tz:${tz}` }));
  await ctx.reply(`Great, **${name}**! Now pick a timezone for your team.`, {
    reply_markup: menuKeyboard(items, 1),
  });
});

composer.callbackQuery(/^team:tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.callbackQuery.data.slice("team:tz:".length);
  ctx.session.teamTimezone = tz;

  const text =
    `Summary:\n\nName: **${ctx.session.teamName}**\nTimezone: **${tz}**\n\nTap Create to set up your team.`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("✅ Create Team", "team:confirm_create")],
      [inlineButton("Cancel", "team:cancel")],
    ]),
  });
});

composer.callbackQuery("team:confirm_create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const name = ctx.session.teamName;
  const tz = ctx.session.teamTimezone;

  if (!name || !tz) {
    resetFlow(ctx);
    await ctx.editMessageText("Something went wrong — start again.");
    return;
  }

  const existing = await store.getUser(ctx.from!.id);
  if (existing) {
    await ctx.editMessageText(
      "You're already part of a team. Leave it first to create a new one.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ My Team", "team:view")]]) },
    );
    resetFlow(ctx);
    return;
  }

  const teamId = `t_${ctx.from!.id}_${nowMs()}`;
  await store.createTeam(teamId, name, tz, ctx.from!.id);
  await store.createUser(ctx.from!.id, ctx.from!.first_name || "Admin", "admin", teamId, tz);

  resetFlow(ctx);
  await ctx.editMessageText(
    `✅ Team **${name}** created! You're the admin.\n\n` +
    "Now add members by tapping Invite Member in your team settings.",
    { reply_markup: inlineKeyboard([[inlineButton("👥 View Team", "team:view")]]) },
  );
});

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

composer.callbackQuery("team:invite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user || user.role !== "admin") {
    await ctx.editMessageText("Only admins can invite members.");
    return;
  }

  const team = await store.getTeam(user.team_id);
  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  const code = `join_${team.team_id}_${nowMs()}`;
  await store.createInvite(team.team_id, code);

  const botUsername = process.env.BOT_USERNAME ?? "TeamReminderBot";
  const deepLink = `https://t.me/${botUsername}?start=${code}`;

  const text =
    `📤 Share this invite link with your team members:\n\n${deepLink}\n\n` +
    `When they open the link and tap Start, they'll join **${team.name}** automatically.\n\n` +
    `Code: \`${code}\``;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to Team", "team:view")]]),
  });
});

// ---------------------------------------------------------------------------
// Handle /start with invite code
// ---------------------------------------------------------------------------

composer.command("start", async (ctx, next) => {
  const payload = ctx.match as string | undefined;
  if (!payload) return next();

  // Check if it looks like an invite code
  if (payload.startsWith("join_")) {
    const store = getStore();
    const teamId = await store.resolveInvite(payload);
    if (!teamId) {
      await ctx.reply("This invite link is invalid or expired. Ask your team admin for a new one.");
      return;
    }

    const team = await store.getTeam(teamId);
    if (!team) {
      await ctx.reply("This team no longer exists.");
      return;
    }

    const existingUser = await store.getUser(ctx.from!.id);
    if (existingUser) {
      await ctx.reply(
        `You're already part of a team. Leave that team first to join another.`,
        { reply_markup: inlineKeyboard([[inlineButton("👥 My Team", "team:view")]]) },
      );
      return;
    }

    await store.createUser(ctx.from!.id, ctx.from!.first_name || "Member", "member", teamId, team.timezone);

    await ctx.reply(
      `✅ Welcome to **${team.name}**! You're now a member.\n\nTap the button below to see your team and reminders.`,
      { reply_markup: inlineKeyboard([[inlineButton("👥 View Team", "team:view")]]) },
    );
    return;
  }

  return next();
});

// ---------------------------------------------------------------------------
// Manual join
// ---------------------------------------------------------------------------

composer.callbackQuery("team:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "join:awaiting_code";

  await ctx.editMessageText(
    "Send me the invite code you received from your team admin.\n\n" +
    "It looks like: `join_team_12345_...`",
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", "team:cancel")]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "join:awaiting_code") return next();

  const code = ctx.message.text.trim();
  const store = getStore();
  const teamId = await store.resolveInvite(code);

  if (!teamId) {
    await ctx.reply("That invite code wasn't found. Double-check with your team admin.");
    return;
  }

  const team = await store.getTeam(teamId);
  if (!team) {
    await ctx.reply("That team no longer exists.");
    return;
  }

  const existingUser = await store.getUser(ctx.from!.id);
  if (existingUser) {
    await ctx.reply("You're already in a team. Leave it first to join another.");
    resetFlow(ctx);
    return;
  }

  await store.createUser(ctx.from!.id, ctx.from!.first_name || "Member", "member", teamId, team.timezone);

  resetFlow(ctx);
  await ctx.reply(`✅ Welcome to **${team.name}**!`, {
    reply_markup: inlineKeyboard([[inlineButton("👥 View Team", "team:view")]]),
  });
});

// ---------------------------------------------------------------------------
// List members
// ---------------------------------------------------------------------------

composer.callbackQuery("team:members", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user) {
    await ctx.editMessageText("You're not in a team.");
    return;
  }

  const team = await store.getTeam(user.team_id);
  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  const members = await store.getTeamMembers(user.team_id);
  if (members.length === 0) {
    await ctx.editMessageText("No members found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:view")]]),
    });
    return;
  }

  const lines = members.map((m) => `• ${m.display_name} (${m.role === "admin" ? "🛡 Admin" : "👤 Member"})`);
  const text = `📋 Members of **${team.name}**:\n\n${lines.join("\n")}`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to Team", "team:view")]]),
  });
});

// ---------------------------------------------------------------------------
// Leave team
// ---------------------------------------------------------------------------

composer.callbackQuery("team:leave", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user) {
    await ctx.editMessageText("You're not in a team.");
    return;
  }

  const team = await store.getTeam(user.team_id);
  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  team.member_ids = team.member_ids.filter((id) => id !== ctx.from!.id);
  team.admin_ids = team.admin_ids.filter((id) => id !== ctx.from!.id);
  await store.updateTeam(team);

  await store.deleteUser(ctx.from!.id);

  await ctx.editMessageText(`You left **${team.name}**. You can create or join a new team anytime.`, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// ---------------------------------------------------------------------------
// Delete team
// ---------------------------------------------------------------------------

composer.callbackQuery("team:delete", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const user = await store.getUser(ctx.from!.id);
  if (!user || user.role !== "admin") {
    await ctx.editMessageText("Only admins can delete the team.");
    return;
  }

  await store.deleteTeam(user.team_id);
  await ctx.editMessageText("🗑 Team deleted. You can create a new one anytime.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

composer.callbackQuery("team:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  resetFlow(ctx);
  await ctx.editMessageText("Cancelled.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

export default composer;