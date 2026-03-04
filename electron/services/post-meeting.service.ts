import { BrowserWindow } from 'electron';
import { sessionStore } from '../store/session.store';
import { fileStore } from '../store/file.store';
import { pipelineLock } from '../utils/pipeline-lock';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';
import { killFfmpeg } from './media.service';
import type { LangCode, InputType, PipelineStep, PipelineState, TranscriptSegment, NormalizedSegment, MeetingMinutes } from '../../shared/types';

const STEPS_RECORDING: PipelineStep[] = ['batch_stt', 'lang_detect', 'normalizing', 'summarizing', 'exporting'];
const STEPS_IMPORT:    PipelineStep[] = ['prepare_audio', 'batch_stt', 'lang_detect', 'normalizing', 'summarizing', 'exporting'];

function notify(win: BrowserWindow, sessionId: string, detail: string): void {
  if (!win.isDestroyed()) win.webContents.send('session:status', { sessionId, status: 'processing', detail });
}

function writeCheckpoint(sessionId: string, steps: PipelineStep[], currentStep: PipelineStep, stepStatus: 'running' | 'done' | 'error'): void {
  const currentIdx = steps.indexOf(currentStep);
  const state: PipelineState = {
    sessionId,
    steps: steps.map((name, i) => ({
      name,
      status: i < currentIdx ? 'done' : i === currentIdx ? stepStatus : 'pending',
      completedAt: i < currentIdx ? Date.now() : undefined,
    })),
    currentStep,
  };
  try { fileStore.writePipeline(sessionId, state); } catch { /* non-fatal */ }
}

class PostMeetingService {
  /**
   * Run (or resume) the post-meeting pipeline.
   * @param startFrom  If provided, jump to this step (crash recovery / retry).
   * @param sourceFilePath  Required for import sessions' prepare_audio step.
   */
  async run(
    sessionId: string, lang: LangCode, inputType: InputType, win: BrowserWindow,
    startFrom?: PipelineStep, sourceFilePath?: string,
  ): Promise<void> {
    if (!pipelineLock.acquire(sessionId, killFfmpeg)) {
      logger.warn('[Pipeline] lock busy', { sessionId, lockedBy: pipelineLock.lockedBy() });
      return;
    }

    const steps = inputType === 'import' ? STEPS_IMPORT : STEPS_RECORDING;

    // Determine start index
    let startIdx = 0;
    if (startFrom) {
      const i = steps.indexOf(startFrom);
      if (i >= 0) startIdx = i;
    } else {
      // Resume from checkpoint: find first non-done step
      const cp = fileStore.readPipeline(sessionId);
      if (cp) {
        const firstPending = cp.steps.findIndex(s => s.status !== 'done');
        if (firstPending >= 0) {
          const pendingStep = cp.steps[firstPending].name;
          const i = steps.indexOf(pendingStep);
          if (i >= 0) startIdx = i;
        }
      }
    }

    try {
      for (let i = startIdx; i < steps.length; i++) {
        const step = steps[i];
        pipelineLock.touch();

        // Idempotency: skip if output already valid
        if (fileStore.isStepOutputValid(sessionId, step)) {
          logger.info('[Pipeline] step already done (idempotent skip)', { sessionId, step });
          writeCheckpoint(sessionId, steps, step, 'done');
          continue;
        }

        notify(win, sessionId, step);
        writeCheckpoint(sessionId, steps, step, 'running');
        logger.info('[Pipeline] running step', { sessionId, step });

        await retry(() => this._runStep(sessionId, step, lang, win, sourceFilePath));
        writeCheckpoint(sessionId, steps, step, 'done');
        logger.info('[Pipeline] step done', { sessionId, step });
      }

      sessionStore.update(sessionId, { status: 'done' });
      const exportPath = fileStore.sessionFile(sessionId, 'export.md');
      if (!win.isDestroyed()) win.webContents.send('session:done', { sessionId, exportPath });
      logger.info('[Pipeline] completed', { sessionId });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Pipeline] failed', { sessionId, error: msg });
      // Mark as recoverable if it's a transient API error (not a 4xx)
      const status4xx = (err as { status?: number })?.status;
      const recoverable = !status4xx || status4xx >= 500;
      sessionStore.markError(sessionId, msg, recoverable);
      if (!win.isDestroyed()) win.webContents.send('error', { code: 'PIPELINE_ERROR', message: msg, sessionId });
    } finally {
      pipelineLock.release();
    }
  }

  private async _runStep(
    sessionId: string, step: PipelineStep, lang: LangCode, _win: BrowserWindow, sourceFilePath?: string,
  ): Promise<void> {
    switch (step) {
      case 'prepare_audio': {
        if (!sourceFilePath) throw new Error('sourceFilePath required for prepare_audio');
        const { mediaService } = await import('./media.service');
        const destPath = fileStore.getWavPath(sessionId);
        await mediaService.extractAudioTo16kMono(sourceFilePath, destPath);
        break;
      }

      case 'batch_stt': {
        const { batchSttService } = await import('./batch-stt.service');
        const segments = await batchSttService.transcribe(sessionId, lang);
        fileStore.writeJsonl(sessionId, 'transcript.jsonl', segments);
        break;
      }

      case 'lang_detect': {
        const { langDetectService } = await import('./lang-detect.service');
        const segments = fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl');
        const detected = langDetectService.detectAll(segments);
        fileStore.writeJsonl(sessionId, 'transcript.jsonl', detected);
        break;
      }

      case 'normalizing': {
        const { normalizationService } = await import('./normalization.service');
        const segments = fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl');
        const normalized = await normalizationService.normalize(segments);
        fileStore.writeJson(sessionId, 'normalized.json', normalized);
        break;
      }

      case 'summarizing': {
        const { summarizationService } = await import('./summarization.service');
        const session    = sessionStore.get(sessionId);
        const normalized = fileStore.readJson<NormalizedSegment[]>(sessionId, 'normalized.json') ?? [];
        const minutes    = await summarizationService.summarize(normalized, sessionId, (session?.lang as LangCode) ?? lang);
        fileStore.writeJson(sessionId, 'minutes.json', minutes);
        break;
      }

      case 'exporting': {
        const { exportService } = await import('./export.service');
        const session  = sessionStore.get(sessionId);
        const minutes  = fileStore.readJson<MeetingMinutes>(sessionId, 'minutes.json');
        const segments = fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl');
        const content  = exportService.toMarkdown({
          title: session?.title ?? 'Meeting', startedAt: session?.startedAt ?? Date.now(),
          durationMs: session?.durationMs ?? null, minutes, segments,
        });
        fileStore.writeMd(sessionId, 'export.md', content);
        break;
      }
    }
  }
}

export const postMeetingService = new PostMeetingService();
