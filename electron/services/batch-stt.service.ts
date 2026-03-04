import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { secretStore } from '../store/secret.store';
import { fileStore }   from '../store/file.store';
import { mediaService } from './media.service';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';
import type { TranscriptSegment, LangCode } from '../../shared/types';

/** Trigger chunking when WAV is larger than this (bytes). */
export const WAV_CHUNK_THRESHOLD = 24_000_000; // 24 MB

/** Levenshtein-based duplicate check — removes segments with ≥95% overlap at chunk boundaries. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const cur = a[i - 1] === b[j - 1] ? dp[j - 1] : 1 + Math.min(dp[j - 1], dp[j], prev);
      dp[j - 1] = prev;
      prev = cur;
    }
    dp[n] = prev;
  }
  return dp[n];
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

async function transcribeSingle(
  client: InstanceType<Awaited<typeof import('openai')>['default']>,
  wavPath: string, lang: LangCode, sessionId: string, offsetMs = 0,
): Promise<TranscriptSegment[]> {
  const resp = await retry(() => client.audio.transcriptions.create({
    file: fs.createReadStream(wavPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
    ...(lang !== 'multi' ? { language: lang } : {}),
  }));
  const segs = (resp as unknown as { segments: Array<{ text: string; start: number; end: number }> }).segments ?? [];
  return segs.filter(s => s.text.trim()).map(s => ({
    id:        uuidv4(),
    sessionId,
    speakerId: 'speaker_0',
    text:      s.text.trim(),
    lang:      lang === 'multi' ? 'ja' : lang,
    startMs:   Math.round(s.start * 1000) + offsetMs,
    endMs:     Math.round(s.end   * 1000) + offsetMs,
  }));
}

class BatchSttService {
  async transcribe(sessionId: string, lang: LangCode): Promise<TranscriptSegment[]> {
    const apiKey = await secretStore.get('openai');
    if (!apiKey) throw new Error('No OpenAI API key configured');

    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });

    // Ensure WAV file exists — convert from PCM if needed
    const wavPath = fileStore.getWavPath(sessionId);
    const pcmPath = fileStore.getAudioPath(sessionId);

    if (!fs.existsSync(wavPath)) {
      if (!fs.existsSync(pcmPath) || fs.statSync(pcmPath).size < 3200) {
        throw new Error('Audio file missing or too short');
      }
      logger.info('[BatchSTT] converting PCM→WAV', { sessionId });
      await mediaService.pcmToWav(pcmPath, wavPath);
    }

    const wavSize = fs.statSync(wavPath).size;
    logger.info('[BatchSTT] wav size', { sessionId, wavSize });

    if (wavSize <= WAV_CHUNK_THRESHOLD) {
      logger.info('[BatchSTT] single file transcription', { sessionId });
      return transcribeSingle(client, wavPath, lang, sessionId);
    }

    // Chunked transcription
    logger.info('[BatchSTT] chunked transcription (>24 MB)', { sessionId, wavSize });
    const tmpDir = path.join(os.tmpdir(), `mtg-chunks-${sessionId}`);
    try {
      const chunks = await mediaService.chunkWav(wavPath, tmpDir);
      logger.info('[BatchSTT] chunks created', { sessionId, count: chunks.length });

      const allSegments: TranscriptSegment[] = [];
      for (const chunk of chunks) {
        const offsetMs = Math.round(chunk.offsetSec * 1000);
        const segs = await transcribeSingle(client, chunk.path, lang, sessionId, offsetMs);
        // Levenshtein dedup guard at chunk boundaries (≥0.95 similarity → skip)
        if (allSegments.length > 0 && segs.length > 0) {
          const lastText = allSegments[allSegments.length - 1].text;
          const firstText = segs[0].text;
          if (similarity(lastText, firstText) >= 0.95) {
            logger.info('[BatchSTT] dedup: skipping duplicate boundary segment');
            segs.shift();
          }
        }
        allSegments.push(...segs);
      }
      return allSegments;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export const batchSttService = new BatchSttService();
