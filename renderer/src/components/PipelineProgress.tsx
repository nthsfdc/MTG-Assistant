import type { PipelineState, PipelineStep } from '../../../shared/types';
import { useT } from '../i18n';

const STEP_ICONS: Record<string, string> = {
  pending: '○',
  running: '▶',
  done:    '✔',
  error:   '✖',
};

const STEP_SHORT: Record<string, string> = {
  prepare_audio: 'audio',
  batch_stt:     'STT',
  lang_detect:   'lang',
  normalizing:   'norm',
  summarizing:   'AI',
  exporting:     'export',
};

interface Props {
  pipeline: PipelineState | null;
  status: string;
  onRetry?: (step: PipelineStep) => void;
  onResume?: () => void;
}

export function PipelineProgress({ pipeline, status, onRetry, onResume }: Props) {
  const { t } = useT();
  const steps = pipeline?.steps ?? [];

  if (!pipeline && status === 'processing') {
    return (
      <div className="flex items-center gap-2 text-text-muted text-sm py-1">
        <span className="animate-spin">◌</span>
        <span>{t.post.processing}</span>
      </div>
    );
  }

  if (!pipeline) return null;

  return (
    <div className="space-y-2">
      {/* Compact horizontal stepper */}
      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((step, idx) => {
          const icon = STEP_ICONS[step.status] ?? '○';
          const label = STEP_SHORT[step.name] ?? step.name;
          const colorClass =
            step.status === 'done'    ? 'text-green-400' :
            step.status === 'running' ? 'text-accent' :
            step.status === 'error'   ? 'text-red-400' :
            'text-text-muted/40';
          return (
            <span key={step.name} className="flex items-center gap-1">
              {idx > 0 && <span className="text-text-muted/30 text-xs">→</span>}
              <span className={`flex items-center gap-0.5 text-xs ${colorClass} ${step.status === 'running' ? 'animate-pulse' : ''}`}>
                <span>{icon}</span>
                <span>{label}</span>
                {step.status === 'error' && onRetry && (
                  <button onClick={() => onRetry(step.name as PipelineStep)}
                    className="ml-1 px-1.5 py-0.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded transition-colors leading-none">
                    {t.post.retryStep}
                  </button>
                )}
              </span>
            </span>
          );
        })}
      </div>

      {status === 'error_recoverable' && onResume && (
        <button onClick={onResume}
          className="w-full py-1.5 text-xs bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent rounded-lg transition-colors">
          {t.post.resumePipeline}
        </button>
      )}
    </div>
  );
}
