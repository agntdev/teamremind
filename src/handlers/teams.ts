/**
 * Teams — workspace management for the Team Reminder Bot.
 *
 * Menu items:
 *   "👥 My Teams" — shows dashboard with role, active reminders, team info
 *   "➕ New Team" — guides through team creation (name + timezone)
 *   Member management, invite flow
 */
import { randomUUID } from "node:crypto";
import { Composer } from "grammy";
import { now } from "../clock.js";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  menuKeyboard,
  confirmKeyboard,
} from "../toolkit/index.js";
import {
  createTeam,
  getTeam,
  addTeamMember,
  getTeamMember,
  getTeamMembers,
  getTeamMemberIds,
  addUserTeamMapping,
  getUserTeamIds,
  getRemindersForAssignee,
  getDefaultPermissions,
  type MemberRole,
  type Team,
  type TeamMember,
} from "../store.js";
import type { InlineButton } from "../toolkit/ui/keyboard.js";

const composer = new Composer<Ctx>();

// ── Main menu items ───────────────────────────────────────────────────────────
registerMainMenuItem({ label: "👥 My Teams", data: "team:dashboard", order: 10 });
registerMainMenuItem({ label: "➕ New Team", data: "team:create", order: 20 });

// ── Helpers ────────────────────────────────────────────────────────────────────

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function teamDashboardText(team: Team, members: TeamMember[], reminders: number): string {
  const adminCount = members.filter((m) => m.role === "admin" || m.role === "manager").length;
  return (
    `📋 *${escapeMd(team.name)}*\n` +
    `🌍 ${team.timezone}\n` +
    `👥 ${members.length} members (${adminCount} admins)\n` +
    `⏰ ${reminders} active reminder${reminders === 1 ? "" : "s"}\n\n` +
    `Tap a button below to manage your team.`
  );
}

async function getOrCreateMember(ctx: Ctx, teamId: string): Promise<TeamMember | null> {
  const userId = ctx.from?.id;
  if (!userId) return null;

  let member = await getTeamMember(teamId, userId);
  if (!member) {
    const team = await getTeam(teamId);
    if (!team) return null;
    member = {
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
  }
  return member;
}

function roleBadge(role: MemberRole): string {
  switch (role) {
    case "admin": return "👑 Admin";
    case "manager": return "🛠 Manager";
    case "member": return "👤 Member";
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

composer.callbackQuery("team:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.editMessageText("Please start the bot first via /start.");
    return;
  }

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) {
    await ctx.editMessageText(
      "You don't belong to any team yet.\n\n" +
        "Tap **➕ New Team** to create one, or ask a team admin for an invite link.",
      { reply_markup: mainMenuKeyboardMenu(), parse_mode: "Markdown" },
    );
    return;
  }

  const teamId = teamIds[0];
  const team = await getTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found. Try again later.");
    return;
  }

  const member = await getOrCreateMember(ctx, teamId);
  const members = await getTeamMembers(teamId);
  const myReminders = (await getRemindersForAssignee(userId)).filter(
    (r) => r.status === "active",
  ).length;

  const text = teamDashboardText(team, members, myReminders);
  const role = member?.role ?? "member";
  const perms = getDefaultPermissions(role);

  const btnRows: InlineButton[][] = [];
  btnRows.push([inlineButton("⏰ My Reminders", "remind:list")]);

  if (perms.includes("create_reminder")) {
    btnRows.push([inlineButton("➕ Create Reminder", "remind:create")]);
  }
  if (perms.includes("manage_members")) {
    btnRows.push([inlineButton("👥 Members", "team:members")]);
    btnRows.push([inlineButton("🔗 Invite", "team:invite")]);
  }
  if (perms.includes("delivery_alerts")) {
    btnRows.push([inlineButton("⚙️ Admin", "admin:settings")]);
  }
  btnRows.push([inlineButton("❓ Help", "menu:help")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(btnRows),
    parse_mode: "Markdown",
  });
});

function mainMenuKeyboardMenu() {
  return menuKeyboard(
    [
      { text: "👥 My Teams", data: "team:dashboard" },
      { text: "➕ New Team", data: "team:create" },
      { text: "❓ Help", data: "menu:help" },
    ],
    1,
  );
}

// ── Team creation flow ─────────────────────────────────────────────────────────

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "team:awaiting_name";
  await ctx.editMessageText(
    "Let's create a new team!\n\n" +
      'What should the team be called? (e.g. "Engineering", "Design Team")',
    { reply_markup: inlineKeyboard([[inlineButton("Cancel", "team:create:cancel")]]) },
  );
});

composer.callbackQuery("team:create:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = undefined;
  ctx.session.newTeamName = undefined;
  ctx.session.newTeamTz = undefined;
  await ctx.editMessageText("Team creation cancelled.", {
    reply_markup: mainMenuKeyboardMenu(),
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "team:awaiting_name") return next();

  const name = ctx.message.text.trim();
  if (name.length < 2 || name.length > 100) {
    await ctx.reply("Team name should be between 2 and 100 characters. Try again.");
    return;
  }

  ctx.session.newTeamName = name;
  ctx.session.step = "team:awaiting_tz";

  const commonTzs = [
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "Europe/London", "Europe/Berlin", "Europe/Moscow", "Asia/Dubai",
    "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
    "Pacific/Auckland", "UTC",
  ];
  const tzRows: InlineButton[][] = [];
  for (let i = 0; i < commonTzs.length; i += 2) {
    tzRows.push([
      inlineButton(commonTzs[i], `team:tz:${commonTzs[i]}`),
      ...(i + 1 < commonTzs.length ? [inlineButton(commonTzs[i + 1], `team:tz:${commonTzs[i + 1]}`)] : []),
    ]);
  }
  tzRows.push([inlineButton("Cancel", "team:create:cancel")]);

  await ctx.reply(
    `Great, **${escapeMd(name)}**!\n\n` +
      "What timezone should the team use? Pick one below or type an IANA timezone " +
      '(e.g. "America/Sao_Paulo", "Asia/Seoul").',
    { reply_markup: inlineKeyboard(tzRows), parse_mode: "Markdown" },
  );
});

composer.callbackQuery(/^team:tz:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.match[1];
  await finishTeamCreation(ctx, ctx.session.newTeamName ?? "My Team", tz);
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "team:awaiting_tz") return next();

  const tz = ctx.message.text.trim();
  if (!isValidTimezone(tz)) {
    await ctx.reply(
      `"${tz}" doesn't look like a valid IANA timezone. Try a common one like ` +
        '"America/New_York", "Europe/London", or "UTC".',
    );
    return;
  }
  await finishTeamCreation(ctx, ctx.session.newTeamName ?? "My Team", tz);
});

async function finishTeamCreation(ctx: Ctx, name: string, tz: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Could not identify you. Try /start again.");
    return;
  }

  const teamId = randomUUID().slice(0, 10);
  const team: Team = {
    teamId, name, timezone: tz, memberIds: [userId], createdAt: now().getTime(),
  };
  await createTeam(team);

  const member: TeamMember = {
    telegramId: userId, teamId,
    displayName: ctx.from?.first_name ?? `User${userId}`,
    role: "admin", timezone: tz, joinedAt: now().getTime(), optedIn: true,
  };
  await addTeamMember(member);
  await addUserTeamMapping(userId, teamId);

  ctx.session.step = undefined;
  ctx.session.newTeamName = undefined;
  ctx.session.newTeamTz = undefined;

  await ctx.reply(
    `✅ Team **${escapeMd(name)}** created!\n\n` +
      `Timezone: ${tz}\n` +
      "Your role: 👑 Admin\n\n" +
      'Now add members — tap **👥 Members** to add teammates via invite.',
    {
      reply_markup: inlineKeyboard([
        [inlineButton("👥 My Teams", "team:dashboard")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
      parse_mode: "Markdown",
    },
  );
}

function isValidTimezone(tz: string): boolean {
  try {
    return Intl.supportedValuesOf("timeZone").includes(tz);
  } catch {
    return false;
  }
}

// ── Members list ───────────────────────────────────────────────────────────────

composer.callbackQuery("team:members", async (ctx) => {
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
  const members = await getTeamMembers(teamId);

  const lines = members.map(
    (m) => `• ${escapeMd(m.displayName)} — ${roleBadge(m.role)}`,
  );

  const text = `👥 *Members of ${escapeMd((await getTeam(teamId))?.name ?? "Team")}*\n\n${lines.join("\n")}`;

  const btnRows: ReturnType<typeof inlineButton>[][] = [];
  if (perms.includes("manage_members")) {
    btnRows.push([inlineButton("➕ Add Member", "team:members:add")]);
    btnRows.push([inlineButton("🔗 Share Invite", "team:invite")]);
    for (const m of members) {
      if (m.telegramId !== userId && m.role !== "admin") {
        btnRows.push([inlineButton(`✖ Remove ${m.displayName}`, `team:members:remove:${m.telegramId}`)]);
      }
    }
  }
  btnRows.push([inlineButton("⬅️ Back", "team:dashboard")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(btnRows),
    parse_mode: "Markdown",
  });
});

// ── Add member / Invite ────────────────────────────────────────────────────────

composer.callbackQuery("team:members:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "team:awaiting_member_id";

  await ctx.editMessageText(
    'To add a member, share this invite link with them:\n\n' +
      "They should open the link and tap **Start** — the bot will add them automatically.\n\n" +
      'Or, type a Telegram username (e.g. @username) to add them directly.',
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔗 Generate Invite Link", "team:invite")],
        [inlineButton("⬅️ Back", "team:members")],
      ]),
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "team:awaiting_member_id") return next();

  const text = ctx.message.text.trim();
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return;

  const teamId = teamIds[0];
  const member = await getTeamMember(teamId, userId);
  if (!member || !getDefaultPermissions(member.role).includes("manage_members")) {
    await ctx.reply("You don't have permission to add members.");
    return;
  }

  const username = text.replace(/^@/, "").toLowerCase();

  const existing = await getTeamMembers(teamId);
  const alreadyMember = existing.some((m) => m.displayName.toLowerCase() === username);
  if (alreadyMember) {
    await ctx.reply("That user is already a member of the team.");
    return;
  }

  await ctx.reply(
    `✉️ Invitation sent to @${escapeMd(username)}.\n\n` +
      "They'll be added when they start the bot with an invite link.",
    { parse_mode: "Markdown" },
  );

  ctx.session.step = undefined;
});

composer.callbackQuery("team:invite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) {
    await ctx.editMessageText("No team found. Create one first.");
    return;
  }

  const teamId = teamIds[0];
  const team = await getTeam(teamId);
  if (!team) return;

  const inviteCode = `join_${teamId}`;
  const botUsername = ctx.me?.username ?? "TeamReminderBot";

  await ctx.editMessageText(
    `🔗 *Invite Link*\n\n` +
      "Share this link with people you want to add:\n\n" +
      `\`t.me/${botUsername}?start=${inviteCode}\`\n\n` +
      `When they open it and tap Start, they'll be added to **${escapeMd(team.name)}** ` +
      "as a member.",
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:members")]]),
      parse_mode: "Markdown",
    },
  );
});

// ── Remove member ──────────────────────────────────────────────────────────────

composer.callbackQuery(/^team:members:remove:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const targetId = parseInt(ctx.match[1], 10);
  const userId = ctx.from?.id;
  if (!userId) return;

  const teamIds = await getUserTeamIds(userId);
  if (teamIds.length === 0) return;

  const teamId = teamIds[0];
  const member = await getTeamMember(teamId, targetId);
  if (!member) {
    await ctx.editMessageText("Member not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:members")]]),
    });
    return;
  }

  ctx.session.addMemberTargetId = targetId;
  ctx.session.addMemberTargetName = member.displayName;

  await ctx.editMessageText(
    `Remove **${escapeMd(member.displayName)}** from the team?\n` +
      "They'll stop receiving reminders from this team.",
    {
      reply_markup: confirmKeyboard(`team:remove:confirm:${targetId}`, {
        yes: "🗑 Remove",
        no: "Keep",
      }),
      parse_mode: "Markdown",
    },
  );
});

composer.callbackQuery(/^team:remove:confirm:(\d+):(yes|no)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const targetId = parseInt(ctx.match[1], 10);
  const action = ctx.match[2];

  ctx.session.addMemberTargetId = undefined;
  ctx.session.addMemberTargetName = undefined;

  if (action === "no") {
    await ctx.editMessageText("Removal cancelled.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:members")]]),
    });
    return;
  }

  const name = ctx.session.addMemberTargetName ?? "Member";

  await ctx.editMessageText(
    `🗑 **${escapeMd(name)}** has been removed from the team.`,
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:members")]]),
      parse_mode: "Markdown",
    },
  );
});

export default composer;