// SPDX-License-Identifier: MIT
import {hash} from './common.mjs';

// Keep migrations 1–6 immutable. Explicit TTLs remain bounded credentials.
export const continuitySchema = `
ALTER TABLE sessions ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0 CHECK(persistent IN (0,1));
`;
export const persistentDeadline = Number.MAX_SAFE_INTEGER;

// Called only inside the new leader's transaction, after outstanding grants
// have been fenced for recovery. Do not infer intent from an eight-hour TTL:
// verify the original enrollment command omitted ttlMs using its fingerprint.
export function upgradeSessionContinuity(store) {
  const db=store.db;
  if(db.prepare("SELECT 1 FROM meta WHERE key='session-continuity-v1'").get())return;
  const rows=db.prepare(`SELECT s.*,c.key,c.payload_hash FROM sessions s JOIN commands c
    ON json_extract(c.response,'$.sessionId')=s.id WHERE c.actor LIKE 'enroll:%' AND s.persistent=0`).all();
  for(const row of rows){
    const body={key:row.key,label:row.label,harness:row.harness,authority:store.authority};
    if(hash(JSON.stringify({operation:'session.open',body}))!==row.payload_hash)continue;
    // Explicit close (including administrator revocation) is permanent.
    const closed=db.prepare("SELECT 1 FROM events WHERE kind='session.closed' AND json_extract(data,'$.session')=? LIMIT 1").get(row.id);
    if(closed)continue;
    const expired=db.prepare("SELECT 1 FROM events WHERE kind='session.expired' AND json_extract(data,'$.session')=? LIMIT 1").get(row.id);
    if(row.closed_at!==null&&!expired)continue;
    const recovering=row.closed_at!==null||row.expires_at<=store.now();
    if(recovering){
      // Restore communication only. Old grants remain revoked, and waiting
      // reservations from the expired session must not start themselves.
      db.prepare("UPDATE tasks SET state='cancelled' WHERE state='queued' AND id IN (SELECT task_id FROM reservations WHERE actor=?)").run(row.id);
      db.prepare("UPDATE claims SET outcome='cancelled' WHERE actor=? AND state='revoking' AND task_id IN (SELECT task_id FROM reservations WHERE actor=?)").run(row.id,row.id);
      db.prepare("UPDATE manager_requests SET release_requested=1 WHERE actor=? AND state NOT IN ('released','cancelled','failed','succeeded')").run(row.id);
    }
    db.prepare('UPDATE sessions SET persistent=1,expires_at=?,closed_at=NULL WHERE id=?').run(persistentDeadline,row.id);
    store.emit('session.continuity_enabled',{session:row.id,recovered:recovering});
  }
  db.prepare("INSERT INTO meta VALUES('session-continuity-v1','done')").run();
}
