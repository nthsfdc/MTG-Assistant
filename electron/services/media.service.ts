import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger';
import type { MediaProbeResult } from '../../shared/types';

function getFfmpegPath(): string {
  try { return require('ffmpeg-static') as string; } catch { return 'ffmpeg'; }
}

function getFfprobePath(): string {
  try {
    const s = require('ffprobe-static') as { path: string };
    return s.path;
  } catch { return 'ffprobe'; }
}

let _ffmpegProc: ChildProcess | null = null;

export function killFfmpeg(): void {
  if (_ffmpegProc) { _ffmpegProc.kill('SIGKILL'); _ffmpegProc = null; }
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const proc = spawn(getFfprobePath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => undefined);
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`ffprobe exit ${code}`)));
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('ffprobe timeout')); }, 30_000);
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    _ffmpegProc = proc;
    let errOut = '';
    proc.stderr.on('data', d => { errOut += d; });
    proc.on('close', code => {
      _ffmpegProc = null;
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errOut.slice(-200)}`));
    });
    proc.on('error', err => { _ffmpegProc = null; reject(err); });
  });
}

class MediaService {
  async probe(filePath: string): Promise<MediaProbeResult> {
    const raw = await runFfprobe([
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ]);
    const info = JSON.parse(raw) as {
      format: { format_name: string; duration: string; size: string };
      streams: { codec_type: string }[];
    };
    return {
      format:      info.format.format_name ?? 'unknown',
      durationSec: parseFloat(info.format.duration ?? '0'),
      hasAudio:    info.streams.some(s => s.codec_type === 'audio'),
      fileSizeBytes: parseInt(info.format.size ?? '0'),
    };
  }

  /** Extract audio track from any media file and convert to 16 kHz mono WAV. */
  async extractAudioTo16kMono(srcPath: string, destPath: string): Promise<void> {
    logger.info('[MediaService] extracting audio', { srcPath, destPath });
    await runFfmpeg([
      '-y', '-i', srcPath,
      '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      destPath,
    ]);
    logger.info('[MediaService] extraction done', { destPath });
  }

  /** Convert PCM16 (16 kHz mono) to WAV. */
  async pcmToWav(pcmPath: string, wavPath: string): Promise<void> {
    await runFfmpeg([
      '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', pcmPath,
      wavPath,
    ]);
  }

  /**
   * Split a WAV into 15-min chunks using ffmpeg segment muxer.
   * Returns array of { path, offsetSec } for each chunk.
   */
  async chunkWav(wavPath: string, tmpDir: string, chunkSec = 900): Promise<{ path: string; offsetSec: number }[]> {
    fs.mkdirSync(tmpDir, { recursive: true });
    const pattern = path.join(tmpDir, 'chunk_%03d.wav');
    await runFfmpeg([
      '-y', '-i', wavPath,
      '-f', 'segment', '-segment_time', String(chunkSec),
      '-c', 'copy', pattern,
    ]);
    const chunks = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('chunk_') && f.endsWith('.wav'))
      .sort();
    return chunks.map((f, i) => ({ path: path.join(tmpDir, f), offsetSec: i * chunkSec }));
  }
}

export const mediaService = new MediaService();
