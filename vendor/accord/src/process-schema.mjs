// SPDX-License-Identifier: MIT
export const processSchema = `
ALTER TABLE state ADD COLUMN phase TEXT NOT NULL DEFAULT 'idle';
CREATE TABLE process_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), manifest TEXT NOT NULL);
CREATE TABLE runs(id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
 effect_key TEXT NOT NULL, pgid INTEGER NOT NULL, birth TEXT NOT NULL, phase TEXT NOT NULL,
 control_token TEXT NOT NULL, socket TEXT NOT NULL, stop_at INTEGER, exit_code INTEGER, output TEXT NOT NULL DEFAULT '', error TEXT, started_at INTEGER NOT NULL, stopped_at INTEGER);
`;
