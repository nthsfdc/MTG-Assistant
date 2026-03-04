import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout }           from './components/Layout';
import { Dashboard }        from './screens/Dashboard';
import { SessionSetup }     from './screens/SessionSetup';
import { RecordingScreen }  from './screens/RecordingScreen';
import { ImportScreen }     from './screens/ImportScreen';
import { PostMeeting }      from './screens/PostMeeting';
import { Settings }         from './screens/Settings';
import { I18nProvider }     from './i18n';
import { RecordingProvider } from './context/RecordingContext';

export function App() {
  return (
    <I18nProvider>
      <RecordingProvider>
        <Layout>
          <Routes>
            <Route path="/"                  element={<Dashboard />} />
            <Route path="/session/setup"     element={<SessionSetup />} />
            <Route path="/session/:id/rec"   element={<RecordingScreen />} />
            <Route path="/session/import"    element={<ImportScreen />} />
            <Route path="/session/:id"       element={<PostMeeting />} />
            <Route path="/settings"          element={<Settings />} />
            <Route path="*"                  element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </RecordingProvider>
    </I18nProvider>
  );
}
