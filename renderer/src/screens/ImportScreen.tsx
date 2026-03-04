import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LangCode } from '../../../shared/types';
import { useT } from '../i18n';

export function ImportScreen() {
  const { t } = useT();
  const navigate = useNavigate();
  const [filePath,  setFilePath]  = useState('');
  const [fileName,  setFileName]  = useState('');
  const [title,     setTitle]     = useState('');
  const [lang,      setLang]      = useState<LangCode>('ja');
  const [probing,   setProbing]   = useState(false);
  const [probeInfo, setProbeInfo] = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  const INPUT_LANGS: { value: LangCode; label: string }[] = [
    { value: 'ja',    label: '🇯🇵 日本語' },
    { value: 'en',    label: '🇺🇸 English' },
    { value: 'vi',    label: '🇻🇳 Tiếng Việt' },
    { value: 'multi', label: t.setup.langMulti },
  ];

  async function handleBrowse() {
    // Use HTML file input via a hidden element
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,video/*,.mp4,.mp3,.wav,.m4a,.ogg,.flac,.webm,.mkv,.mov,.avi';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      // electron exposes full path via webkitRelativePath or path property
      const path = (file as File & { path?: string }).path ?? '';
      if (!path) { setError(t.import.noPathError); return; }
      setFilePath(path);
      setFileName(file.name);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
      // Probe the file
      setProbing(true); setProbeInfo(''); setError('');
      try {
        const info = await window.api.media.probe(path);
        if (!info.hasAudio) { setError(t.import.noAudioError); setFilePath(''); setFileName(''); return; }
        const mins = Math.floor(info.durationSec / 60);
        const secs = Math.floor(info.durationSec % 60);
        setProbeInfo(`${info.format.toUpperCase()} • ${mins}:${secs.toString().padStart(2,'0')} • ${(info.fileSizeBytes / 1024 / 1024).toFixed(1)} MB`);
      } catch {
        setError(t.import.probeError);
      } finally {
        setProbing(false);
      }
    };
    input.click();
  }

  async function handleImport() {
    if (!filePath || loading) return;
    setError(''); setLoading(true);
    try {
      const sessionTitle = title.trim() || fileName || new Date().toLocaleString(t.dateLocale);
      const { sessionId } = await window.api.session.import({ title: sessionTitle, lang, filePath });
      navigate(`/session/${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.import.failed);
      setLoading(false);
    }
  }

  const sel = (label: string, value: string, onChange: (v: string) => void, children: React.ReactNode) => (
    <div>
      <label className="block text-xs font-medium text-text-dim mb-1.5">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2.5 bg-surface-2 border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent">
        {children}
      </select>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0">
        <button onClick={() => navigate('/')} className="text-text-muted hover:text-text-primary transition-colors">←</button>
        <h1 className="text-base font-semibold text-text-primary">{t.import.title}</h1>
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-5">
          {/* File picker */}
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1.5">{t.import.fileLabel}</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2.5 bg-surface-2 border border-border rounded-lg text-sm truncate text-text-muted">
                {fileName || t.import.noFileSelected}
              </div>
              <button onClick={handleBrowse} disabled={probing}
                className="px-3.5 py-2.5 bg-surface-2 border border-border rounded-lg text-sm text-text-dim hover:text-text-primary hover:border-accent transition-colors disabled:opacity-50">
                {probing ? '…' : t.import.browse}
              </button>
            </div>
            {probeInfo && <p className="text-xs text-text-muted mt-1">{probeInfo}</p>}
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1.5">{t.setup.titleLabel}</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder={new Date().toLocaleString(t.dateLocale)} autoFocus
              className="w-full px-3 py-2.5 bg-surface-2 border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          {/* Language */}
          {sel(t.setup.inputLang, lang, v => setLang(v as LangCode),
            INPUT_LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)
          )}

          {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button onClick={() => navigate('/')}
              className="flex-1 py-2.5 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary hover:border-text-muted transition-colors">
              {t.setup.cancel}
            </button>
            <button onClick={handleImport} disabled={!filePath || loading}
              className="flex-1 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm transition-colors disabled:opacity-50">
              {loading ? t.import.importing : t.import.startImport}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
