# Team Reminder Bot — Bot specification

**Archetype:** workflow

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot for team task coordination via assignable reminders. Admins/Managers create one-time or recurring reminders with due-time DM notifications to assignees. Includes team workspace management, status tracking, and delivery failure alerts for admins.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Team managers
- Project administrators
- Collaborative workgroups

## Success criteria

- Admins can create teams with timezone settings
- Users receive direct message reminders at scheduled times
- Assignees can mark reminders as done or snooze
- Admins receive delivery failure alerts
- All reminder data persists across sessions

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open team dashboard with current user's role and active reminders
- **/remind create** (command, actor: user, command: /remind create) — Launch guided reminder creation flow
  - inputs: title, assignee, schedule type
  - outputs: Reminder creation confirmation with edit options
- **Mark Done** (button, actor: user, callback: reminder:complete) — Mark assigned reminder as completed
  - inputs: reminder ID
  - outputs: Completion confirmation and creator notification
- **Snooze** (button, actor: user, callback: reminder:snooze) — Reschedule reminder with preset delay
  - inputs: reminder ID, snooze duration
  - outputs: Updated next run timestamp

## Flows

### Onboarding
_Trigger:_ /start

1. Display team selection/login
2. Admin creates new team with timezone
3. Add initial members via username or invite link

_Data touched:_ Team, User

### Reminder Creation
_Trigger:_ /remind create

1. Collect title and assignee
2. Select schedule type and recurrence
3. Confirm and schedule reminder

_Data touched:_ Reminder

### Reminder Delivery
_Trigger:_ Scheduled time reached

1. Send DM to assignee with action buttons
2. Track delivery status
3. Handle snooze/completion responses

_Data touched:_ Reminder status, Delivery history

### Team Management
_Trigger:_ /remind list

1. Filter reminders by status/owner
2. Display paginated list with next actions
3. Allow cancellation/editing where permitted

_Data touched:_ Reminder, User permissions

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Team** _(retention: persistent)_ — Shared workspace with timezone and member list
  - fields: team_id, name, timezone, member_list
- **User** _(retention: persistent)_ — Team member with role and status
  - fields: telegram_id, display_name, role, status, preferred_timezone
- **Reminder** _(retention: persistent)_ — Task reminder with schedule and status tracking
  - fields: id, title, description, assignee_id, creator_id, schedule_type, next_run, timezone, status, delivery_history
- **Role** _(retention: persistent)_ — User permissions within team
  - fields: role_type, permissions

## Integrations

- **Telegram** (required) — Bot API messaging and user authentication
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create/delete teams
- Manage team members and roles
- Configure delivery failure alerts
- Set default creator notification preferences

## Notifications

- Direct message reminders to assignees
- Admin alerts for persistent delivery failures
- Creator notifications on completion

## Permissions & privacy

- Role-based access to reminder creation/assignment
- Persistent storage of team data with opt-in consent
- No third-party data sharing

## Edge cases

- User blocks bot after reminder sent
- Invalid timezone configuration during team creation
- Conflicting reminder schedules for same assignee

## Required tests

- End-to-end reminder delivery workflow
- Role-based access validation
- Recurring reminder scheduling accuracy
- Delivery failure alert handling

## Assumptions

- Teams will maintain active members with accessible Telegram accounts
- Admins will configure timezones correctly
- Users will accept bot messages to receive reminders
