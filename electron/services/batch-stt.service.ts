import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { secretStore } from '../store/secret.store';
import type { TranscriptSegment, LangCode } from '../../shared/types';

function pcmToWav(pcm: Buffer): Buffer {
  const sr = 16000, ch = 1, bps = 16;
  const h = Buffer.allocUnsafe(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * ch * bps / 8, 28);
  h.writeUInt16LE(ch * bps / 8, 32); h.writeUInt16LE(bps, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

class BatchSttService {
  async transcribe(audioPath: string, lang: LangCode, sessionId: string): Promise<TranscriptSegment[]> {
    const apiKey = await secretStore.get('openai');
    if (!apiKey) throw new Error('No OpenAI key');
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 3200) throw new Error('Audio too short');

    const wavPath = path.join(os.tmpdir(), `mtg-${uuidv4()}.wav`);
    try {
      fs.writeFileSync(wavPath, pcmToWav(fs.readFileSync(audioPath)));
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey });
      const resp = await client.audio.transcriptions.create({
        file: fs.createReadStream(wavPath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
        ...(lang !== 'multi' && lang !== 'en' ? { language: lang } : {}),
      });
      const segs = (resp as unknown as { segments: Array<{ text: string; start: number; end: number }> }).segments ?? [];
      return segs.filter(s => s.text.trim()).map(s => ({
        id: uuidv4(), sessionId, speakerId: 'speaker_0',
        text: s.text.trim(), lang: lang === 'multi' ? 'ja' : lang,
        startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000),
      }));
    } finally {
      fs.unlink(wavPath, () => undefined);
    }
  }
}

export const batchSttService = new BatchSttService();
