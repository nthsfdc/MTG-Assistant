import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout }       from './components/Layout';
import { Dashboard }    from './screens/Dashboard';
import { SessionSetup } from './screens/SessionSetup';
import { LiveSession }  from './screens/LiveSession';
import { PostMeeting }  from './screens/PostMeeting';
import { Settings }     from './screens/Settings';
import { I18nProvider } from './i18n';

export function App() {
  return (
    <I18nProvider>
    <Layout>
      <Routes>
        <Route path="/"                 element={<Dashboard />} />
        <Route path="/session/setup"    element={<SessionSetup />} />
        <Route path="/session/:id/live" element={<LiveSession />} />
        <Route path="/session/:id"      element={<PostMeeting />} />
        <Route path="/settings"         element={<Settings />} />
        <Route path="*"                 element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
    </I18nProvider>
  );
}
