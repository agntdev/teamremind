import { createRequire } from "node:module";
import type { StorageAdapter } from "grammy";

/**
 * Durable storage for domain data — the persistent counterpart to session
 * storage (which is for ephemeral conversation state only).
 *
 * Uses the same auto-select pattern as the toolkit's session storage: Redis
 * when REDIS_URL is set, in-memory otherwise. Never call `KEYS` / `SCAN` /
 * readAll — all lookups go through explicit index records.
 */

// ---------------------------------------------------------------------------
// Minimal Redis-like interface (mirrors the toolkit's RedisLike)
// ---------------------------------------------------------------------------
export interface StoreBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// In-memory backend (dev / test / no-Redis fallback)
// ---------------------------------------------------------------------------
export class MemoryStoreBackend implements StoreBackend {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Redis backend (production)
// ---------------------------------------------------------------------------
export class RedisStoreBackend implements StoreBackend {
  constructor(private client: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown>; del(key: string): Promise<unknown> }) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string): Promise<unknown> {
    return this.client.set(key, value);
  }

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
  }
}

/** Build a Redis backend from REDIS_URL using ioredis (lazy-loaded). */
export function defaultRedisBackend(url: string): StoreBackend {
  const require = createRequire(import.meta.url);
  const ioredis: any = require("ioredis");
  const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
  const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  return new RedisStoreBackend(client);
}

/** Resolve the storage backend: explicit → Redis (REDIS_URL) → in-memory. */
export function resolveBackend(
  explicit?: StoreBackend,
  env: { REDIS_URL?: string } = process.env,
  make: (url: string) => StoreBackend = defaultRedisBackend,
): StoreBackend {
  if (explicit) return explicit;
  if (env.REDIS_URL) return make(env.REDIS_URL);
  return new MemoryStoreBackend();
}

// ---------------------------------------------------------------------------
// Singleton backend — set once at startup
// ---------------------------------------------------------------------------
let _backend = resolveBackend();

/** Override backend (test hook). */
export function _setBackend(b: StoreBackend): void {
  _backend = b;
}

const prefix = "remind:";

function k(parts: string[]): string {
  return prefix + parts.join(":");
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------
export type MemberRole = "admin" | "manager" | "member";
export type ReminderStatus = "active" | "completed" | "cancelled" | "delivery_failed";
export type ScheduleType = "once" | "daily" | "weekly" | "monthly" | "weekdays";

export interface Team {
  teamId: string;
  name: string;
  timezone: string;
  memberIds: number[];
  createdAt: number;
}

export interface TeamMember {
  telegramId: number;
  teamId: string;
  displayName: string;
  role: MemberRole;
  /** The member's own timezone preference (may differ from the team's). */
  timezone: string;
  joinedAt: number;
  optedIn: boolean;
}

export interface DeliveryEvent {
  at: number;
  status: "delivered" | "failed" | "snoozed";
  reason?: string;
}

export interface Reminder {
  id: string;
  title: string;
  description: string;
  assigneeId: number;
  creatorId: number;
  teamId: string;
  scheduleType: ScheduleType;
  nextRun: number;          // unix ms
  timezone: string;
  status: ReminderStatus;
  deliveryHistory: DeliveryEvent[];
  createdAt: number;
  snoozeUntil?: number;     // unix ms; set when snoozed
}

// ---------------------------------------------------------------------------
// Index helpers — NEVER scan the keyspace. Every collection is an index record.
// ---------------------------------------------------------------------------

// ---- Teams ----
const TEAMS_INDEX = "idx:teams";        // string[] of teamIds

export async function createTeam(team: Team): Promise<void> {
  const idxKey = k([TEAMS_INDEX]);
  const raw = await _backend.get(idxKey);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(team.teamId)) ids.push(team.teamId);
  await _backend.set(idxKey, JSON.stringify(ids));
  await _backend.set(k(["team", team.teamId]), JSON.stringify(team));
}

export async function getAllTeamIds(): Promise<string[]> {
  const raw = await _backend.get(k([TEAMS_INDEX]));
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export async function getTeam(teamId: string): Promise<Team | null> {
  const raw = await _backend.get(k(["team", teamId]));
  return raw ? (JSON.parse(raw) as Team) : null;
}

// ---- Team members ----
const MEMBER_INDEX_PREFIX = "idx:team:members:"; // idx:team:members:<teamId> → number[]

export async function addTeamMember(member: TeamMember): Promise<void> {
  const idxKey = k([MEMBER_INDEX_PREFIX + member.teamId]);
  const raw = await _backend.get(idxKey);
  const ids: number[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(member.telegramId)) ids.push(member.telegramId);
  await _backend.set(idxKey, JSON.stringify(ids));
  await _backend.set(k(["member", `${member.teamId}_${member.telegramId}`]), JSON.stringify(member));
}

export async function getTeamMemberIds(teamId: string): Promise<number[]> {
  const raw = await _backend.get(k([MEMBER_INDEX_PREFIX + teamId]));
  return raw ? (JSON.parse(raw) as number[]) : [];
}

export async function getTeamMember(teamId: string, telegramId: number): Promise<TeamMember | null> {
  const raw = await _backend.get(k(["member", `${teamId}_${telegramId}`]));
  return raw ? (JSON.parse(raw) as TeamMember) : null;
}

export async function getTeamMembers(teamId: string): Promise<TeamMember[]> {
  const ids = await getTeamMemberIds(teamId);
  const members: TeamMember[] = [];
  for (const id of ids) {
    const m = await getTeamMember(teamId, id);
    if (m) members.push(m);
  }
  return members;
}

// ---- Reminders ----
const REMINDER_INDEX_PREFIX_ASSIGNEE = "idx:reminders:assignee:";  // idx:reminders:assignee:<userId> → string[] of reminder ids
const REMINDER_INDEX_PREFIX_TEAM = "idx:reminders:team:";          // idx:reminders:team:<teamId> → string[]

export async function createReminder(reminder: Reminder): Promise<void> {
  const remKey = k(["reminder", reminder.id]);
  await _backend.set(remKey, JSON.stringify(reminder));

  // Index by assignee
  const aKey = k([REMINDER_INDEX_PREFIX_ASSIGNEE + reminder.assigneeId]);
  const aRaw = await _backend.get(aKey);
  const aIds: string[] = aRaw ? JSON.parse(aRaw) : [];
  if (!aIds.includes(reminder.id)) aIds.push(reminder.id);
  await _backend.set(aKey, JSON.stringify(aIds));

  // Index by team
  const tKey = k([REMINDER_INDEX_PREFIX_TEAM + reminder.teamId]);
  const tRaw = await _backend.get(tKey);
  const tIds: string[] = tRaw ? JSON.parse(tRaw) : [];
  if (!tIds.includes(reminder.id)) tIds.push(reminder.id);
  await _backend.set(tKey, JSON.stringify(tIds));
}

export async function getReminder(id: string): Promise<Reminder | null> {
  const raw = await _backend.get(k(["reminder", id]));
  return raw ? (JSON.parse(raw) as Reminder) : null;
}

export async function updateReminder(reminder: Reminder): Promise<void> {
  await _backend.set(k(["reminder", reminder.id]), JSON.stringify(reminder));
}

export async function getRemindersForAssignee(assigneeId: number): Promise<Reminder[]> {
  const raw = await _backend.get(k([REMINDER_INDEX_PREFIX_ASSIGNEE + assigneeId]));
  const ids: string[] = raw ? JSON.parse(raw) : [];
  const reminders: Reminder[] = [];
  for (const id of ids) {
    const r = await getReminder(id);
    if (r) reminders.push(r);
  }
  return reminders;
}

export async function getTeamReminders(teamId: string): Promise<Reminder[]> {
  const raw = await _backend.get(k([REMINDER_INDEX_PREFIX_TEAM + teamId]));
  const ids: string[] = raw ? JSON.parse(raw) : [];
  const reminders: Reminder[] = [];
  for (const id of ids) {
    const r = await getReminder(id);
    if (r) reminders.push(r);
  }
  return reminders;
}

/**
 * Find reminders whose nextRun has passed (or snoozeUntil has passed) and
 * are active. Since we don't scan keyspace, we iterate via per-assignee
 * index but that's bounded by the number of users who have reminders — not
 * the whole keyspace. An index team-by-team still requires iterating team
 * indices. For production scale, a scheduler table or sorted-set would be
 * better — but for this bot's scope, the per-assignee + per-team index
 * approach avoids O(N) key scans.
 */
export async function getDueReminders(nowMs: number, teamIds: string[]): Promise<Reminder[]> {
  const due: Reminder[] = [];
  for (const teamId of teamIds) {
    const raw = await _backend.get(k([REMINDER_INDEX_PREFIX_TEAM + teamId]));
    const ids: string[] = raw ? JSON.parse(raw) : [];
    for (const id of ids) {
      const r = await getReminder(id);
      if (r && r.status === "active") {
        const effectiveNext = r.snoozeUntil && r.snoozeUntil > nowMs ? r.snoozeUntil : r.nextRun;
        if (effectiveNext <= nowMs) {
          due.push(r);
        }
      }
    }
  }
  return due;
}

// ---- User -> team mapping (find a user's team) ----
const USER_TEAMS_INDEX = "idx:user:teams:"; // idx:user:teams:<telegramId> → string[]

export async function addUserTeamMapping(telegramId: number, teamId: string): Promise<void> {
  const key = k([USER_TEAMS_INDEX + telegramId]);
  const raw = await _backend.get(key);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(teamId)) ids.push(teamId);
  await _backend.set(key, JSON.stringify(ids));
}

export async function getUserTeamIds(telegramId: number): Promise<string[]> {
  const raw = await _backend.get(k([USER_TEAMS_INDEX + telegramId]));
  return raw ? (JSON.parse(raw) as string[]) : [];
}

// ---- Role/permissions ----
const ROLES_INDEX = "idx:roles"; // string[] of role types

export function getDefaultPermissions(role: MemberRole): string[] {
  switch (role) {
    case "admin":
      return ["create_team", "delete_team", "manage_members", "create_reminder", "assign_reminder", "cancel_any", "view_all", "delivery_alerts"];
    case "manager":
      return ["create_reminder", "assign_reminder", "cancel_own", "view_team", "delivery_alerts"];
    case "member":
      return ["create_own_reminder", "view_own", "mark_done", "snooze"];
  }
}

export async function isAdmin(telegramId: number): Promise<boolean> {
  const teamIds = await getUserTeamIds(telegramId);
  for (const teamId of teamIds) {
    const m = await getTeamMember(teamId, telegramId);
    if (m && (m.role === "admin" || m.role === "manager")) return true;
  }
  return false;
}

// ---- Reset for tests ----
export async function _resetStore(): Promise<void> {
  // In-memory: we can simply create a fresh backend
  _backend = new MemoryStoreBackend();
}

export function _getBackend(): StoreBackend {
  return _backend;
}
