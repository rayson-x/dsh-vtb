import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyProgrammeRecording } from './programme-recording.mjs';
test('the capture integrity gate rejects changed or unbound media before any player opens it',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'programme-integrity-'));
 try{
  const contents={'capture.json':JSON.stringify({kind:'actual-programme-capture',width:1920,height:1080,fps:30,from:1000,until:2000}),'programme.mp4':'integrity-fixture','picture.mp4':'integrity-picture','programme.wav':'integrity-sound'};
  const files={};for(const [name,bytes]of Object.entries(contents)){await writeFile(join(folder,name),bytes);files[name]=createHash('sha256').update(bytes).digest('hex');}
  await writeFile(join(folder,'manifest.json'),JSON.stringify({files}));
  assert.equal((await verifyProgrammeRecording(folder)).recording.until,2000);
  await writeFile(join(folder,'picture.mp4'),'changed');
  await assert.rejects(()=>verifyProgrammeRecording(folder),/modified: picture.mp4/);
  await writeFile(join(folder,'manifest.json'),JSON.stringify({files:{}}));
  await assert.rejects(()=>verifyProgrammeRecording(folder),/every programme resource/);
 }finally{await rm(folder,{recursive:true,force:true});}
});
