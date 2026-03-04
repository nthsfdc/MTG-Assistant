import type { PipelineState, PipelineStep } from '../../../shared/types';
import { useT } from '../i18n';

const STEP_ICONS: Record<string, string> = {
  pending: '○',
  running: '◌',
  done:    '●',
  error:   '✕',
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
      <div className="flex items-center gap-2 text-text-muted text-sm py-2">
        <span className="animate-spin">◌</span>
        <span>{t.post.processing}</span>
      </div>
    );
  }

  if (!pipeline) return null;

  return (
    <div className="space-y-1">
      {steps.map(step => (
        <div key={step.name} className="flex items-center gap-2.5 py-1">
          <span className={`text-xs w-4 text-center flex-shrink-0 ${
            step.status === 'done'    ? 'text-green-400' :
            step.status === 'running' ? 'text-accent animate-pulse' :
            step.status === 'error'   ? 'text-red-400' :
            'text-text-muted/40'
          }`}>
            {STEP_ICONS[step.status] ?? '○'}
          </span>
          <span className={`text-xs flex-1 ${
            step.status === 'done'    ? 'text-text-muted' :
            step.status === 'running' ? 'text-text-primary font-medium' :
            step.status === 'error'   ? 'text-red-400' :
            'text-text-muted/50'
          }`}>
            {t.post.steps[step.name as keyof typeof t.post.steps] ?? step.name}
          </span>
          {step.status === 'error' && onRetry && (
            <button onClick={() => onRetry(step.name as PipelineStep)}
              className="text-xs px-2 py-0.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded transition-colors">
              {t.post.retryStep}
            </button>
          )}
        </div>
      ))}
      {(status === 'error_recoverable') && onResume && (
        <div className="pt-2">
          <button onClick={onResume}
            className="w-full py-2 text-xs bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent rounded-lg transition-colors">
            {t.post.resumePipeline}
          </button>
        </div>
      )}
    </div>
  );
}
