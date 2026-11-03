/** Integrity gate for captured media; decoding and native Film validation follow this gate. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export async function verifyProgrammeRecording(folder) {
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  const required = ['capture.json','programme.mp4','picture.mp4','programme.wav'];
  if (!manifest.files || required.some(name => typeof manifest.files[name] !== 'string') || Object.keys(manifest.files).some(name => !required.includes(name)))
    throw Error('Capture manifest must bind every programme resource');
  for (const name of required) {
    const hash = manifest.files[name];
    if (!/^[a-f0-9]{64}$/.test(hash) || createHash('sha256').update(await readFile(join(folder, name))).digest('hex') !== hash)
      throw Error('Captured media was modified: ' + name);
  }
  const recording = JSON.parse(await readFile(join(folder, 'capture.json'), 'utf8'));
  if (recording.kind !== 'actual-programme-capture' || recording.width !== 1920 || recording.height !== 1080 || recording.fps !== 30 || !Number.isFinite(recording.from) || !Number.isFinite(recording.until) || recording.until <= recording.from)
    throw Error('Invalid captured programme timeline');
  return { recording, manifest };
}
