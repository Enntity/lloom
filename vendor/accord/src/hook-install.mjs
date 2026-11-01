// SPDX-License-Identifier: MIT
import { requireThat } from './common.mjs';
// Merge only Accord's marked handlers. Preserve unrelated hooks, order and policy.
export function mergeContextHooks(config,command,{source}={}) {
  requireThat(config&&typeof config==='object'&&!Array.isArray(config),'INSTALL_CONFLICT','Hook configuration must be an object');
  const hooks=config.hooks??{};
  requireThat(hooks&&typeof hooks==='object'&&!Array.isArray(hooks),'INSTALL_CONFLICT','Existing hooks must be an object');
  const result={...config,hooks:{...hooks}};
  for(const event of ['SessionStart','UserPromptSubmit','PostToolUse',...(source==='claude'?['Stop']:[])]){
    const groups=hooks[event]??[];requireThat(Array.isArray(groups),'INSTALL_CONFLICT','Existing hook event must contain matcher groups');
    const kept=[];
    for(const group of groups){
      requireThat(group&&Array.isArray(group.hooks),'INSTALL_CONFLICT','Existing hook group must contain handlers');
      const remaining=group.hooks.filter(h=>!(h.type==='command'&&typeof h.command==='string'&&h.command.includes(' --accord-context-hook ')));
      if(remaining.length||remaining.length===group.hooks.length)kept.push({...group,hooks:remaining});
    }
    result.hooks[event]=[...kept,{hooks:[{type:'command',command,timeout:2}]}];
  }
  return result;
}
