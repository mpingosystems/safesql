import { useEffect, useState } from 'react';
import type { SchemaDefinition } from '../types/validation';
import { parseDDL } from '../services/schemaParser';
import { useSchemaLibrary, type SavedSchema } from '../hooks/useSchemaLibrary';
import { listSchemaConnections, type SchemaConnectionSummary } from '../services/schemaConnections';

interface SchemaPanelProps {
  schema: SchemaDefinition | null;
  onSchemaChange: (schema: SchemaDefinition | null) => void;
  ddl: string;
  onDdlChange: (next: string) => void;
  appUserId: string | null;
  activeSchemaId: string | null;
  onActiveSchemaChange: (id: string | null) => void;
}

export function SchemaPanel({
  schema,
  onSchemaChange,
  ddl,
  onDdlChange,
  appUserId,
  activeSchemaId,
  onActiveSchemaChange,
}: SchemaPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const { schemas, saveSchema, deleteSchema, isLoading } = useSchemaLibrary(appUserId);

  // Sprint 9 — live schema connections (auto-imported, zero DDL paste).
  const [connections, setConnections] = useState<SchemaConnectionSummary[]>([]);
  useEffect(() => {
    if (!appUserId) {
      setConnections([]);
      return;
    }
    void listSchemaConnections(appUserId).then(setConnections);
  }, [appUserId]);

  const handleLoadConnection = (conn: SchemaConnectionSummary) => {
    if (!conn.schema_cache || conn.schema_cache.tables.length === 0) {
      setError('This connection has no synced schema yet — run "Sync now" in Settings.');
      return;
    }
    setError(null);
    onActiveSchemaChange(null);
    onSchemaChange(conn.schema_cache);
    onDdlChange(`-- Loaded from connection: ${conn.name} (${conn.dialect})\n-- ${conn.schema_cache.tables.length} tables auto-imported`);
  };

  const isAuthed = !!appUserId;

  const handleParse = () => {
    setError(null);
    if (!ddl.trim()) {
      setError('Paste CREATE TABLE statements to parse.');
      return;
    }
    const parsed = parseDDL(ddl);
    if (parsed.tables.length === 0) {
      setError('No CREATE TABLE statements detected. Each statement must end with a semicolon.');
      onSchemaChange(null);
      return;
    }
    onSchemaChange(parsed);
  };

  const handleClear = () => {
    onDdlChange('');
    setError(null);
    onSchemaChange(null);
    onActiveSchemaChange(null);
  };

  const handleLoadSaved = (s: SavedSchema) => {
    onDdlChange(s.ddl);
    onActiveSchemaChange(s.id);
    setError(null);
    const parsed = parseDDL(s.ddl);
    onSchemaChange(parsed.tables.length > 0 ? parsed : null);
  };

  const handleSave = async () => {
    if (!saveName.trim()) return;
    if (!ddl.trim()) {
      setError('Nothing to save — paste DDL first.');
      return;
    }
    const saved = await saveSchema({ name: saveName.trim(), ddl });
    if (saved) {
      onActiveSchemaChange(saved.id);
      setSavePromptOpen(false);
      setSaveName('');
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await deleteSchema(id);
    if (ok && activeSchemaId === id) onActiveSchemaChange(null);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#0f0f10',
        borderRight: '1px solid #27272a',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid #27272a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontWeight: 600, color: '#e4e4e7', fontSize: 13 }}>Schema</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={handleParse} style={btnPrimary}>
            Parse DDL
          </button>
          <button type="button" onClick={handleClear} style={btnSecondary}>
            Clear
          </button>
        </div>
      </div>

      <textarea
        value={ddl}
        onChange={(e) => onDdlChange(e.target.value)}
        placeholder={`-- Paste CREATE TABLE statements\nCREATE TABLE users (\n  id UUID PRIMARY KEY,\n  email TEXT NOT NULL\n);`}
        spellCheck={false}
        style={{
          flex: '0 0 200px',
          padding: 10,
          background: '#0a0a0a',
          color: '#e4e4e7',
          border: 'none',
          borderBottom: '1px solid #27272a',
          fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
          fontSize: 12,
          resize: 'none',
          outline: 'none',
        }}
      />

      {connections.length > 0 && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid #27272a', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#a1a1aa' }}>Load from:</span>
          <select
            defaultValue=""
            onChange={(e) => {
              const c = connections.find((x) => x.id === e.target.value);
              if (c) handleLoadConnection(c);
              e.target.value = '';
            }}
            style={{ flex: 1, background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 4, padding: '4px 6px', fontSize: 11.5 }}
          >
            <option value="" disabled>DDL paste · or a connection…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.dialect}){c.last_synced_at ? '' : ' — not synced'}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {error && (
          <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: 8 }}>{error}</div>
        )}
        {!schema || schema.tables.length === 0 ? (
          <div style={{ color: '#52525b', fontSize: 12 }}>
            No tables loaded. Paste DDL and click Parse.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {schema.tables.map((t) => (
              <li
                key={t.name}
                style={{
                  padding: '6px 8px',
                  borderRadius: 4,
                  marginBottom: 4,
                  background: '#18181b',
                  fontSize: 12,
                }}
              >
                <div style={{ color: '#e4e4e7', fontWeight: 600 }}>{t.name}</div>
                <div style={{ color: '#71717a', fontSize: 11 }}>
                  {t.columns.length} columns
                  {t.columns.some((c) => c.isPK) && ' · PK'}
                  {t.columns.some((c) => c.isFK) && ' · FK'}
                </div>
              </li>
            ))}
          </ul>
        )}

        {isAuthed && (
          <div style={{ marginTop: 14, borderTop: '1px solid #27272a', paddingTop: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <span style={{ fontSize: 11, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Saved schemas
              </span>
              {!savePromptOpen ? (
                <button
                  type="button"
                  onClick={() => setSavePromptOpen(true)}
                  style={{ ...btnSecondary, padding: '3px 8px' }}
                >
                  + Save current
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSavePromptOpen(false);
                    setSaveName('');
                  }}
                  style={{ ...btnSecondary, padding: '3px 8px' }}
                >
                  Cancel
                </button>
              )}
            </div>

            {savePromptOpen && (
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder="Name (e.g. ecommerce-prod)"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSave();
                  }}
                  style={{
                    flex: 1,
                    background: '#0a0a0a',
                    color: '#e4e4e7',
                    border: '1px solid #27272a',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 12,
                  }}
                  autoFocus
                />
                <button type="button" onClick={() => void handleSave()} style={btnPrimary}>
                  Save
                </button>
              </div>
            )}

            {isLoading ? (
              <div style={{ fontSize: 11, color: '#52525b' }}>Loading…</div>
            ) : schemas.length === 0 ? (
              <div style={{ fontSize: 11, color: '#52525b' }}>
                Nothing saved yet. Click "+ Save current" to add this schema to your library.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {schemas.map((s) => (
                  <li
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px',
                      borderRadius: 4,
                      marginBottom: 3,
                      background: activeSchemaId === s.id ? '#1e1b4b' : '#18181b',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                    onClick={() => handleLoadSaved(s)}
                  >
                    <span style={{ color: '#e4e4e7', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(s.id);
                      }}
                      title="Delete"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#71717a',
                        cursor: 'pointer',
                        fontSize: 14,
                        padding: '0 4px',
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  background: '#7c3aed',
  color: 'white',
  border: 'none',
  borderRadius: 4,
  padding: '5px 10px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: '#a1a1aa',
  border: '1px solid #3f3f46',
  borderRadius: 4,
  padding: '5px 10px',
  fontSize: 11,
  cursor: 'pointer',
};
