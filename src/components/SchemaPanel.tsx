import { useState } from 'react';
import type { SchemaDefinition } from '../types/validation';
import { parseDDL } from '../services/schemaParser';

interface SchemaPanelProps {
  schema: SchemaDefinition | null;
  onSchemaChange: (schema: SchemaDefinition | null) => void;
  initialDDL?: string;
}

export function SchemaPanel({ schema, onSchemaChange, initialDDL = '' }: SchemaPanelProps) {
  const [ddl, setDdl] = useState(initialDDL);
  const [error, setError] = useState<string | null>(null);

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
    setDdl('');
    setError(null);
    onSchemaChange(null);
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
        onChange={(e) => setDdl(e.target.value)}
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
