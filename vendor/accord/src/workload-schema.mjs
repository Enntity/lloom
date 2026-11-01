// SPDX-License-Identifier: MIT
// Migration 3 for managed and POSIX resource drivers; checksummed by database().
export const workloadJournalMigration = `CREATE TABLE external_workload_journal(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);`;
