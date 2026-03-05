import type { PipelineState, PipelineStep } from '../../../shared/types';
import { useT } from '../i18n';

const STEP_ICONS: Record<string, string> = {
  pending: '○',
  running: '▶',
  done:    '✔',
  error:   '✖',
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

  const runningStep = steps.find(s => s.status === 'running');
  const errorStep   = steps.find(s => s.status === 'error');
  const activeStep  = errorStep ?? runningStep;
  const activeLabel = activeStep
    ? t.post.steps[activeStep.name as keyof typeof t.post.steps] ?? activeStep.name
    : null;

  return (
    <div className="space-y-1.5">
      {/* Compact icon-only stepper */}
      <div className="flex items-center gap-1">
        {steps.map((step, idx) => {
          const icon = STEP_ICONS[step.status] ?? '○';
          const colorClass =
            step.status === 'done'    ? 'text-green-400' :
            step.status === 'running' ? 'text-accent' :
            step.status === 'error'   ? 'text-red-400' :
            'text-text-muted/30';
          return (
            <span key={step.name} className="flex items-center gap-1">
              {idx > 0 && <span className="text-text-muted/20 text-xs">→</span>}
              <span className={`text-xs ${colorClass} ${step.status === 'running' ? 'animate-pulse' : ''}`}>
                {icon}
              </span>
            </span>
          );
        })}
      </div>

      {/* Current step description */}
      {activeLabel && (
        <div className="flex items-center gap-2">
          <span className={`text-xs ${errorStep ? 'text-red-400' : 'text-text-muted'}`}>
            {activeLabel}
          </span>
          {errorStep && onRetry && (
            <button onClick={() => onRetry(errorStep.name as PipelineStep)}
              className="px-1.5 py-0.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded text-xs transition-colors leading-none">
              {t.post.retryStep}
            </button>
          )}
        </div>
      )}
      {status === 'error_recoverable' && onResume && (
        <button onClick={onResume}
          className="w-full py-1.5 text-xs bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent rounded-lg transition-colors">
          {t.post.resumePipeline}
        </button>
      )}
    </div>
  );
}
