import { ipcMain } from 'electron';
import { searchIndexService } from '../services/search-index.service';

export function registerSearchIpc(): void {
  ipcMain.handle('search:query', (_evt, { query }: { query: string }): string[] =>
    searchIndexService.query(query),
  );
}
