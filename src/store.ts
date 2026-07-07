/**
 * Persistent data store for the Team Reminder Bot.
 *
 * Durable domain data lives here, backed by a KV client interface.
 * In-memory (tests / dev) or Redis (production) — the store is agnostic.
 *
 * RULES:
 *  - No keyspace scans (no KEYS / SCAN / readAll).
 *  - Every collection is read through explicit index records.
 *  - Every write updates both the record AND its indices atomically.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoleType = "admin" | "member";
export type UserStatus = "active" | "blocked";
export type ReminderStatus = "active" | "paused" | "completed" | "cancelled";
export type ScheduleType = "once" | "daily" | "weekly" | "monthly" | "weekdays";
export type DeliveryStatus = "sent" | "delivered" | "failed";

export interface DeliveryRecord {
  at: string; // ISO timestamp
  status: DeliveryStatus;
  error?: string;
}

export interface Team {
  team_id: string;
  name: string;
  timezone: string;
  member_ids: number[]; // Telegram user IDs of members
  admin_ids: number[];  // Telegram user IDs of admins
  created_at: string;
}

export interface User {
  telegram_id: number;
  display_name: string;
  role: RoleType;
  status: UserStatus;
  preferred_timezone: string;
  team_id: string;
  joined_at: string;
}

export interface Reminder {
  id: string;
  title: string;
  description: string;
  assignee_id: number;
  creator_id: number;
  team_id: string;
  schedule_type: ScheduleType;
  /** ISO 8601 string of the next planned run. null if not scheduled yet. */
  next_run: string | null;
  /** Interval in minutes for recurring reminders. 0 for once-only. */
  interval_minutes: number;
  timezone: string;
  status: ReminderStatus;
  delivery_history: DeliveryRecord[];
  created_at: string;
  updated_at: string;
  /** Number of consecutive delivery failures. */
  consecutive_failures: number;
}

/** Minimal key-value interface (same shape as toolkit's RedisLike). */
export interface KVClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Counter helpers
// ---------------------------------------------------------------------------

const COUNTER_KEY = "meta:reminder_counter";
const INVITE_COUNTER_KEY = "meta:invite_counter";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class DataStore {
  constructor(private readonly kv: KVClient) {}

  // ---- Team ----

  async createTeam(id: string, name: string, timezone: string, creatorId: number): Promise<Team> {
    const team: Team = {
      team_id: id,
      name,
      timezone,
      member_ids: [creatorId],
      admin_ids: [creatorId],
      created_at: new Date().toISOString(),
    };
    await this.kv.set(`team:${id}`, JSON.stringify(team));
    // Update index: all teams
    const allTeams = await this._getIndex<string[]>("idx:all_teams");
    allTeams.push(id);
    await this.kv.set("idx:all_teams", JSON.stringify(allTeams));
    return team;
  }

  async getTeam(id: string): Promise<Team | null> {
    const raw = await this.kv.get(`team:${id}`);
    return raw ? (JSON.parse(raw) as Team) : null;
  }

  async updateTeam(team: Team): Promise<void> {
    await this.kv.set(`team:${team.team_id}`, JSON.stringify(team));
  }

  async deleteTeam(id: string): Promise<void> {
    const team = await this.getTeam(id);
    if (!team) return;
    // Remove members from user index
    for (const mid of team.member_ids) {
      await this.kv.del(`user:${mid}`);
    }
    // Remove reminders
    const assigneeIdx = await this._getIndex<string[]>(`idx:reminders_assignee:${id}`);
    for (const rid of assigneeIdx) await this.kv.del(`reminder:${rid}`);
    await this.kv.del(`idx:reminders_assignee:${id}`);

    const creatorIdx = await this._getIndex<string[]>(`idx:reminders_creator:${id}`);
    for (const rid of creatorIdx) await this.kv.del(`reminder:${rid}`);
    await this.kv.del(`idx:reminders_creator:${id}`);

    // Remove from all teams index
    const allTeams = await this._getIndex<string[]>("idx:all_teams");
    const filtered = allTeams.filter((t) => t !== id);
    await this.kv.set("idx:all_teams", JSON.stringify(filtered));

    await this.kv.del(`team:${id}`);
  }

  async listTeams(): Promise<Team[]> {
    const ids = await this._getIndex<string[]>("idx:all_teams");
    const teams: Team[] = [];
    for (const id of ids) {
      const t = await this.getTeam(id);
      if (t) teams.push(t);
    }
    return teams;
  }

  // ---- User ----

  async createUser(
    telegramId: number,
    displayName: string,
    role: RoleType,
    teamId: string,
    timezone: string,
  ): Promise<User> {
    const user: User = {
      telegram_id: telegramId,
      display_name: displayName,
      role,
      status: "active",
      preferred_timezone: timezone,
      team_id: teamId,
      joined_at: new Date().toISOString(),
    };
    await this.kv.set(`user:${telegramId}`, JSON.stringify(user));

    // Add to team member index
    const team = await this.getTeam(teamId);
    if (team) {
      if (!team.member_ids.includes(telegramId)) {
        team.member_ids.push(telegramId);
      }
      if (role === "admin" && !team.admin_ids.includes(telegramId)) {
        team.admin_ids.push(telegramId);
      }
      await this.updateTeam(team);
    }

    return user;
  }

  async getUser(telegramId: number): Promise<User | null> {
    const raw = await this.kv.get(`user:${telegramId}`);
    return raw ? (JSON.parse(raw) as User) : null;
  }

  async updateUser(user: User): Promise<void> {
    await this.kv.set(`user:${user.telegram_id}`, JSON.stringify(user));
  }

  async deleteUser(telegramId: number): Promise<void> {
    const user = await this.getUser(telegramId);
    if (!user) return;
    // Remove from team member index
    const team = await this.getTeam(user.team_id);
    if (team) {
      team.member_ids = team.member_ids.filter((id) => id !== telegramId);
      team.admin_ids = team.admin_ids.filter((id) => id !== telegramId);
      await this.updateTeam(team);
    }
    await this.kv.del(`user:${telegramId}`);
  }

  async getTeamMembers(teamId: string): Promise<User[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const users: User[] = [];
    for (const mid of team.member_ids) {
      const u = await this.getUser(mid);
      if (u) users.push(u);
    }
    return users;
  }

  // ---- Reminder ----

  async nextReminderId(): Promise<string> {
    const raw = await this.kv.get(COUNTER_KEY);
    const next = (raw ? parseInt(raw, 10) : 0) + 1;
    await this.kv.set(COUNTER_KEY, String(next));
    return `rem_${next}`;
  }

  async createReminder(
    reminder: Omit<Reminder, "id" | "created_at" | "updated_at" | "delivery_history" | "consecutive_failures" | "next_run"> &
      Partial<Pick<Reminder, "next_run">>,
  ): Promise<Reminder> {
    const id = await this.nextReminderId();
    const now = new Date().toISOString();
    const r: Reminder = {
      ...reminder,
      id,
      created_at: now,
      updated_at: now,
      delivery_history: [],
      consecutive_failures: 0,
      next_run: reminder.next_run ?? null,
    };
    await this.kv.set(`reminder:${id}`, JSON.stringify(r));

    // Index by assignee
    const assigneeIdx = await this._getIndex<string[]>(`idx:reminders_assignee:${r.assignee_id}`);
    assigneeIdx.push(id);
    await this.kv.set(`idx:reminders_assignee:${r.assignee_id}`, JSON.stringify(assigneeIdx));

    // Index by creator
    const creatorIdx = await this._getIndex<string[]>(`idx:reminders_creator:${r.creator_id}`);
    creatorIdx.push(id);
    await this.kv.set(`idx:reminders_creator:${r.creator_id}`, JSON.stringify(creatorIdx));

    return r;
  }

  async getReminder(id: string): Promise<Reminder | null> {
    const raw = await this.kv.get(`reminder:${id}`);
    return raw ? (JSON.parse(raw) as Reminder) : null;
  }

  async updateReminder(reminder: Reminder): Promise<void> {
    reminder.updated_at = new Date().toISOString();
    await this.kv.set(`reminder:${reminder.id}`, JSON.stringify(reminder));
  }

  async deleteReminder(id: string): Promise<void> {
    const r = await this.getReminder(id);
    if (!r) return;

    // Remove from assignee index
    const assigneeIdx = await this._getIndex<string[]>(`idx:reminders_assignee:${r.assignee_id}`);
    const filteredA = assigneeIdx.filter((rid) => rid !== id);
    await this.kv.set(`idx:reminders_assignee:${r.assignee_id}`, JSON.stringify(filteredA));

    // Remove from creator index
    const creatorIdx = await this._getIndex<string[]>(`idx:reminders_creator:${r.creator_id}`);
    const filteredC = creatorIdx.filter((rid) => rid !== id);
    await this.kv.set(`idx:reminders_creator:${r.creator_id}`, JSON.stringify(filteredC));

    await this.kv.del(`reminder:${id}`);
  }

  /** List reminders assigned to a user, optionally filtered by status. */
  async listRemindersForAssignee(assigneeId: number, status?: ReminderStatus): Promise<Reminder[]> {
    const ids = await this._getIndex<string[]>(`idx:reminders_assignee:${assigneeId}`);
    return this._resolveReminders(ids, status);
  }

  /** List reminders created by a user, optionally filtered by status. */
  async listRemindersForCreator(creatorId: number, status?: ReminderStatus): Promise<Reminder[]> {
    const ids = await this._getIndex<string[]>(`idx:reminders_creator:${creatorId}`);
    return this._resolveReminders(ids, status);
  }

  /** Find reminders that are past-due and still active. */
  async findDueReminders(): Promise<Reminder[]> {
    const now = new Date().toISOString();
    const allTeamIds = await this._getIndex<string[]>("idx:all_teams");
    const due: Reminder[] = [];
    for (const tid of allTeamIds) {
      const team = await this.getTeam(tid);
      if (!team) continue;
      for (const mid of team.member_ids) {
        const reminders = await this.listRemindersForAssignee(mid, "active");
        for (const r of reminders) {
          if (r.next_run && r.next_run <= now) {
            due.push(r);
          }
        }
      }
    }
    return due;
  }

  // ---- Delivery failure tracking ----

  async recordDelivery(reminderId: string, status: DeliveryStatus, error?: string): Promise<void> {
    const r = await this.getReminder(reminderId);
    if (!r) return;
    r.delivery_history.push({
      at: new Date().toISOString(),
      status,
      ...(error ? { error } : {}),
    });
    if (status === "failed") {
      r.consecutive_failures = (r.consecutive_failures ?? 0) + 1;
    } else if (status === "delivered" || status === "sent") {
      r.consecutive_failures = 0;
    }
    await this.updateReminder(r);
  }

  /** Find reminders with delivery failures beyond the threshold. */
  async findFailingReminders(threshold = 3): Promise<Array<{ reminder: Reminder; assignee: User | null; creator: User | null }>> {
    const allTeamIds = await this._getIndex<string[]>("idx:all_teams");
    const results: Array<{ reminder: Reminder; assignee: User | null; creator: User | null }> = [];
    for (const tid of allTeamIds) {
      const team = await this.getTeam(tid);
      if (!team) continue;
      for (const mid of team.member_ids) {
        const reminders = await this.listRemindersForAssignee(mid, "active");
        for (const r of reminders) {
          if ((r.consecutive_failures ?? 0) >= threshold) {
            const assignee = await this.getUser(r.assignee_id);
            const creator = await this.getUser(r.creator_id);
            results.push({ reminder: r, assignee, creator });
          }
        }
      }
    }
    return results;
  }

  // ---- Invite codes ----

  async createInvite(teamId: string, code: string): Promise<void> {
    // Store the invite mapping
    await this.kv.set(`invite:${code}`, JSON.stringify({ team_id: teamId }));
    // Add to team's invite index
    const idxKey = `idx:invites:${teamId}`;
    const raw = await this.kv.get(idxKey);
    const invites: string[] = raw ? JSON.parse(raw) : [];
    invites.push(code);
    await this.kv.set(idxKey, JSON.stringify(invites));
  }

  async resolveInvite(code: string): Promise<string | null> {
    const raw = await this.kv.get(`invite:${code}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { team_id: string };
    return data.team_id;
  }

  // ---- Private helpers ----

  private async _getIndex<T>(key: string): Promise<T> {
    const raw = await this.kv.get(key);
    if (raw == null) {
      // Return a default empty value based on type expectation
      return (Array.isArray([]) ? [] : {}) as T;
    }
    return JSON.parse(raw) as T;
  }

  async _resolveReminders(ids: string[], status?: ReminderStatus): Promise<Reminder[]> {
    const reminders: Reminder[] = [];
    for (const id of ids) {
      const r = await this.getReminder(id);
      if (r && (!status || r.status === status)) {
        reminders.push(r);
      }
    }
    return reminders;
  }
}

// ---------------------------------------------------------------------------
// In-memory KV client (dev / test)
// ---------------------------------------------------------------------------

export class InMemoryKV implements KVClient {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Clear all data. For test setup only. */
  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton helpers for convenience
// ---------------------------------------------------------------------------

let _store: DataStore | null = null;

/**
 * Get or create the singleton DataStore.
 * Uses in-memory KV by default; pass a Redis KV to switch to production.
 */
export function getStore(kv?: KVClient): DataStore {
  if (!_store) {
    _store = new DataStore(kv ?? new InMemoryKV());
  }
  return _store;
}

/** Reset the singleton store (for tests). */
export function resetStore(): void {
  _store = null;
}