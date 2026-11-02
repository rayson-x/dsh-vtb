import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventLog } from '../src/live/runtime/file-log';
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
it('recovers the durable event prefix after a torn final WAL write and can append again', () => {
 const folder=mkdtempSync(join(tmpdir(),'aivtb-wal-'));folders.push(folder);const path=join(folder,'events.jsonl');
 const log=new FileEventLog(path);log.append({eventId:'a',type:'show.command',source:'runtime',receivedAt:1,showTime:123,directionEpoch:1,payload:{facts:[]}});log.close();
 appendFileSync(path,'{"kind":"event"');
 const recovered=new FileEventLog(path);expect(recovered.snapshot().events.map(e=>e.eventId)).toEqual(['a']);
 recovered.append({eventId:'b',type:'show.command',source:'runtime',receivedAt:2,showTime:456,directionEpoch:1,payload:{facts:[]}});recovered.close();
 const again=new FileEventLog(path);expect(again.snapshot().events.map(e=>[e.eventId,e.sequence])).toEqual([['a',1],['b',2]]);again.close();
});
