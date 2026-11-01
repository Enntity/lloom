// SPDX-License-Identifier: MIT
// Migration 10: verified native-conversation bindings retain access to their mail.
// Resource ownership and old session credentials are deliberately not transferred.
export const messageAttentionSchema = `
CREATE TABLE session_mailbox_aliases(source TEXT NOT NULL, external_id TEXT NOT NULL, actor TEXT NOT NULL REFERENCES actors(id), PRIMARY KEY(source,external_id,actor));
INSERT INTO session_mailbox_aliases SELECT source,external_id,actor FROM session_bindings;
CREATE INDEX session_mailbox_alias_actor ON session_mailbox_aliases(actor);
`;
