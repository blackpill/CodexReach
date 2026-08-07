import { describe, expect, it } from 'vitest';
import { groupProjects, type CodexThread } from './types.js';
const thread = (id:string,cwd:string,updatedAt:number):CodexThread => ({id,sessionId:id,preview:id,name:null,cwd,createdAt:updatedAt,updatedAt,status:{type:'idle'},turns:[]});
describe('groupProjects',()=>{it('按 cwd 聚合并按最近更新排序',()=>{const result=groupProjects([thread('a','/work/one',1),thread('b','/work/two',3),thread('c','/work/one',2)]);expect(result.map(x=>x.name)).toEqual(['two','one']);expect(result[1].sessions.map(x=>x.id)).toEqual(['c','a'])})});
