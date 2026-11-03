// SPDX-License-Identifier: MIT
// A transcript record is not another addressable agent, even when its title matches.
export const discoveryGuidance = 'Participants are joined peers; your own entry is omitted. Observations are transcript/UI records, not additional collaborators. Read-only work need not wait on observations.';
export function splitDiscovery(rows, selfAddress) {
  const participants = [], observations = [];
  for (const row of rows ?? []) {
    const id = row.address?.split('/').at(-1) ?? '';
    if ((selfAddress && (row.address === selfAddress || row.participantAddress === selfAddress)) || id.startsWith('remote-')) continue;
    // Older linked hosts do not send kind. Their observed-* IDs are adapter records.
    const observed = row.kind === 'observation' || (!row.kind && id.startsWith('observed-'));
    if (observed) observations.push({...row, kind:'observation'});
    else participants.push(row);
  }
  const joined = new Set(participants.map(p=>p.address));
  const seen = new Set();
  return {participants, observations:observations.filter(row=>{
    // A host-authenticated binding is identity evidence; labels and paths are not.
    if (joined.has(row.participantAddress)) return false;
    const key = row.participantAddress || row.address;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  })};
}
