// SPDX-License-Identifier: MIT
// Migration 8: preserve records while hiding internal harness activity. Index
// live queues separately from historical rows; retry tombstones are never pruned.
export const discoveryCleanupSchema = `
ALTER TABLE session_views ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));
CREATE INDEX live_tasks ON tasks(state) WHERE state IN ('queued','preparing','running','recovering','releasing','cancelling');
CREATE INDEX pending_mail ON message_outbox(state) WHERE state='queued';
CREATE INDEX live_manager_requests ON manager_requests(state) WHERE state NOT IN ('released','cancelled','failed','succeeded');
`;
