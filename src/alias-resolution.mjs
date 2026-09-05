export function aliasMemberIds(alias) {
  if (typeof alias === 'string') return [alias];
  const normalized = alias ?? {};
  const members = Array.isArray(normalized.members)
    ? normalized.members
    : [normalized.target, ...(Array.isArray(normalized.fallbacks) ? normalized.fallbacks : [])];
  return members.filter(
    (member, index, all) => typeof member === 'string' && member.length > 0 && all.indexOf(member) === index
  );
}

export function aliasSuspendedMemberIds(alias) {
  if (!alias || typeof alias === 'string') return [];
  const members = new Set(aliasMemberIds(alias));
  return (Array.isArray(alias.suspendedMembers) ? alias.suspendedMembers : []).filter(
    (member, index, all) => members.has(member) && all.indexOf(member) === index
  );
}

export function aliasRoutableMemberIds(alias) {
  const suspended = new Set(aliasSuspendedMemberIds(alias));
  return aliasMemberIds(alias).filter((member) => !suspended.has(member));
}

// Expand nested aliases depth first, preserving leaf order and suspensions.
// A same-name direct self-member resolves its model; other alias references recurse.
export function expandedAliasMemberIds(aliasId, aliases, modelIds, { includeSuspended = false } = {}) {
  const leaves = [];
  const seen = new Set();
  function visit(id, path) {
    if (!Object.hasOwn(aliases, id) || (modelIds.has(id) && id === path.at(-1))) {
      if (!seen.has(id)) {
        seen.add(id);
        leaves.push(id);
      }
      return;
    }
    expand(id, path);
  }
  function expand(id, path) {
    if (path.includes(id)) throw new Error(`alias cycle: ${[...path, id].join(' -> ')}`);
    const members = includeSuspended ? aliasMemberIds(aliases[id]) : aliasRoutableMemberIds(aliases[id]);
    for (const member of members) visit(member, [...path, id]);
  }
  expand(aliasId, []);
  return leaves;
}
