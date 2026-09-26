/**
 * 路径展开：把扩展状态空间上的状态路径铺回成节点序列。
 *
 * 状态路径里每个状态都携带「当前所在节点」，相邻状态由进入边衔接，
 * 因此节点序列就是依次取每个状态的 node。
 */

import { NodeId, State } from './graph';

export function unfoldStatePath(states: State[]): NodeId[] {
  return states.map((s) => s.node);
}
