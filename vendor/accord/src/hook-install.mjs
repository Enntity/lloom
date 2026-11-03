// SPDX-License-Identifier: MIT
import { requireThat } from './common.mjs';
// Merge only Accord's marked handlers. Preserve unrelated hooks, order and policy.
// `fast` handles routine boundaries; `full` is the Node hook. Accord's own tools always
// take `full`, because their results bind the native conversation to its session.
export function mergeContextHooks(config,{full,fast=full,wake,hold},{source}={}) {
  requireThat(config&&typeof config==='object'&&!Array.isArray(config),'INSTALL_CONFLICT','Hook configuration must be an object');
  const hooks=config.hooks??{};
  requireThat(hooks&&typeof hooks==='object'&&!Array.isArray(hooks),'INSTALL_CONFLICT','Existing hooks must be an object');
  const result={...config,hooks:{...hooks}};
  for(const event of ['SessionStart','UserPromptSubmit','PostToolUse',...(source==='claude'||hold?['Stop']:[])]){
    const groups=hooks[event]??[];requireThat(Array.isArray(groups),'INSTALL_CONFLICT','Existing hook event must contain matcher groups');
    const kept=[];
    for(const group of groups){
      requireThat(group&&Array.isArray(group.hooks),'INSTALL_CONFLICT','Existing hook group must contain handlers');
      const remaining=group.hooks.filter(h=>!(h.type==='command'&&typeof h.command==='string'&&h.command.includes(' --accord-context-hook ')));
      if(remaining.length||remaining.length===group.hooks.length)kept.push({...group,hooks:remaining});
    }
    const entry=(command,fields={timeout:2})=>({hooks:[{type:'command',command,...fields}]});
    const added={SessionStart:[entry(full)],UserPromptSubmit:[entry(full)],
      PostToolUse:[entry(fast),{matcher:'mcp__accord__.*',...entry(full)}],
      Stop:[...(source==='claude'?[entry(fast)]:[]),...(wake?[entry(wake,{asyncRewake:true,timeout:86400})]:[]),...(hold?[entry(hold,{timeout:600})]:[])]}[event];
    result.hooks[event]=[...kept,...added];
  }
  return result;
}
