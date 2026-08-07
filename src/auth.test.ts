import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from './auth.js';
describe('AuthStore',()=>{it('配对码只能成功一次',async()=>{const auth=new AuthStore(await mkdtemp(path.join(tmpdir(),'bridge-')));await auth.init();const code=auth.rotatePairCode();const token=auth.pair(code);expect(token).toBeTruthy();expect(auth.verify(`Bearer ${token}`)).toBe(true);expect(auth.pair(code)).toBeNull()})});
