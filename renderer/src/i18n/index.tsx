import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { locales, type UILang, type Locale } from './locales';

interface I18nCtx { t: Locale; uiLang: UILang; setUiLang: (l: UILang) => void }

const I18nContext = createContext<I18nCtx>({ t: locales.ja, uiLang: 'ja', setUiLang: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [uiLang, setUiLangState] = useState<UILang>('ja');

  useEffect(() => {
    window.api.settings.get().then(s => {
      const l = (s as { uiLang?: string }).uiLang;
      if (l && l in locales) setUiLangState(l as UILang);
    }).catch(() => undefined);
  }, []);

  function setUiLang(l: UILang) {
    setUiLangState(l);
    window.api.settings.save({ uiLang: l } as never).catch(() => undefined);
  }

  return (
    <I18nContext.Provider value={{ t: locales[uiLang], uiLang, setUiLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() { return useContext(I18nContext); }
