# Shared project group quarantine: protective perimeter

This change adds a persistent chat tombstone and an outgoing Feishu message gate. It does not enable Android/iOS, migrate historical topics, or prove session-to-repository ownership.

## Behavior

- Configure comma-separated `FEISHU_QUARANTINED_CHAT_IDS` on the actual service. Valid entries are persisted before receiving events. Removing the variable does not remove tombstones.
- Isolated group messages and card callbacks cannot execute actions. Callback chat identity must come from authenticated event context, not card payload.
- Both SDK message aliases are guarded. Replies and card patches read the exact message to verify its destination; unknown/deleted/unreadable messages fail closed. Normal operations therefore require message-read permission and are subject to API limits.
- Group creation uses hashed full paths rather than truncated prefixes. Isolated chats cannot be reused or rebound.
- No group member, historical topic, or message is deleted. The bot remains in the old group.

## Deployment gate

1. Confirm the exact production database and affected chat IDs; back up SQLite using its backup API, env and supervisor configuration.
2. Ensure no running tasks; stop the old instance and prevent supervisor restart during the cutover. Do not run two versions against the same state.
3. Configure the isolation IDs and start the reviewed version; verify tombstones in that same database before changing bindings or admitting new tasks.
4. Verify real group and direct-message reads/replies/card updates, and refusal of old-group callbacks and notifications. Do not assert success from mock tests alone.
5. Old versions do not honor tombstones. Rollback must keep Feishu processing stopped until an equally protective version is available.

Independent group binding and mobile dispatch require separate reviewed changes and end-to-end acceptance; this PR is not that enablement.
