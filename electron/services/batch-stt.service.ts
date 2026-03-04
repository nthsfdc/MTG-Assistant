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

/** Whisper hard upload limit (25 MiB). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 26,214,400

/** Safe per-chunk budget — 23 MiB leaves ~2 MiB headroom under the limit. */
const SAFE_UPLOAD_BYTES = 23 * 1024 * 1024; // 24,117,248

/** PCM16 16 kHz mono: 16000 samples/s × 1 ch × 2 bytes/sample = 32,000 B/s. */
const PCM16_16K_MONO_BYTES_PER_SEC = 32_000;

/** Compute chunk duration so each chunk stays within SAFE_UPLOAD_BYTES. */
function computeChunkSec(): number {
  const raw = Math.floor(SAFE_UPLOAD_BYTES / PCM16_16K_MONO_BYTES_PER_SEC); // 753 s
  return Math.max(60, Math.min(raw, 900)); // clamp to [60, 900]
}

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
    if (wavSize === 0) throw new Error('Audio WAV file is empty — cannot transcribe');
    logger.info('[BatchSTT] wav ready', { sessionId, wavSizeBytes: wavSize });

    if (wavSize <= WAV_CHUNK_THRESHOLD) {
      logger.info('[BatchSTT] single file transcription', { sessionId });
      return transcribeSingle(client, wavPath, lang, sessionId);
    }

    // Chunked transcription — compute size-safe chunk duration
    const chunkSec = computeChunkSec();
    logger.info('[BatchSTT] chunked transcription', { sessionId, wavSizeBytes: wavSize, chunkSec });
    const tmpDir = path.join(os.tmpdir(), `mtg-chunks-${sessionId}`);
    try {
      let chunks = await mediaService.chunkWav(wavPath, tmpDir, chunkSec);
      logger.info('[BatchSTT] chunks created', { sessionId, numberOfChunks: chunks.length,
        perChunkEstimateBytes: chunkSec * PCM16_16K_MONO_BYTES_PER_SEC });

      // Validate and fallback: if any chunk still exceeds MAX_UPLOAD_BYTES, re-chunk at 300 s
      const oversized = chunks.filter(c => {
        if (!fs.existsSync(c.path)) throw new Error(`Chunk file missing: ${c.path}`);
        const sz = fs.statSync(c.path).size;
        if (sz === 0) throw new Error(`Chunk file is empty: ${c.path}`);
        return sz > MAX_UPLOAD_BYTES;
      });
      if (oversized.length > 0) {
        logger.warn('[BatchSTT] oversized chunks detected, re-chunking at 300 s', { sessionId, count: oversized.length });
        fs.rmSync(tmpDir, { recursive: true, force: true });
        chunks = await mediaService.chunkWav(wavPath, tmpDir, 300);
        logger.info('[BatchSTT] re-chunked', { sessionId, numberOfChunks: chunks.length });
      }

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
