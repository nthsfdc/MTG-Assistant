import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LangCode } from '../../../shared/types';
import { useT } from '../i18n';

export function SessionSetup() {
  const { t } = useT();
  const navigate = useNavigate();
  const [title,         setTitle]         = useState('');
  const [lang,          setLang]          = useState<LangCode>('ja');
  const [inputDeviceId, setInputDeviceId] = useState('');
  const [mics,          setMics]          = useState<MediaDeviceInfo[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState('');

  useEffect(() => {
    window.api.settings.get().then(s => setInputDeviceId(s.inputDeviceId)).catch(() => undefined);
    navigator.mediaDevices.enumerateDevices().then(d => setMics(d.filter(x => x.kind === 'audioinput')));
  }, []);

  const INPUT_LANGS: { value: LangCode; label: string }[] = [
    { value: 'ja',    label: '🇯🇵 日本語' },
    { value: 'en',    label: '🇺🇸 English' },
    { value: 'vi',    label: '🇻🇳 Tiếng Việt' },
    { value: 'multi', label: t.setup.langMulti },
  ];

  async function handleStart() {
    if (loading) return;
    setError(''); setLoading(true);
    try {
      await window.api.settings.save({ inputDeviceId });
      const sessionTitle = title.trim() || new Date().toLocaleString(t.dateLocale);
      const { sessionId } = await window.api.session.start({ title: sessionTitle, lang });
      navigate(`/session/${sessionId}/rec`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.setup.failedToStart);
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
        <h1 className="text-base font-semibold text-text-primary">{t.setup.title}</h1>
      </div>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-5">
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1.5">{t.setup.titleLabel}</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleStart()}
              placeholder={new Date().toLocaleString(t.dateLocale)} autoFocus
              className="w-full px-3 py-2.5 bg-surface-2 border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          {sel(t.setup.inputLang, lang, v => setLang(v as LangCode),
            INPUT_LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)
          )}
          {sel(t.settings.mic, inputDeviceId, setInputDeviceId, <>
            <option value="">{t.settings.systemDefault}</option>
            {mics.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || t.settings.micN(i + 1)}</option>)}
          </>)}
          {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button onClick={() => navigate('/')}
              className="flex-1 py-2.5 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary hover:border-text-muted transition-colors">
              {t.setup.cancel}
            </button>
            <button onClick={handleStart} disabled={loading}
              className="flex-1 py-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm transition-colors disabled:opacity-50">
              {loading ? t.setup.starting : t.setup.start}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
