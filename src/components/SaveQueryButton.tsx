import { useState } from 'react';
import { useTeam } from '../hooks/useTeam';
import { getSupabase } from '../services/supabaseClient';
import { saveQuery } from '../services/queryLibrary';

// Sprint 9 Part 3 — "Save current query" button shown in the editor header after
// a validation run. Opens a small dialog (title + tags + share toggle), pre-fills
// the title from the first table name in the SQL.
interface Props {
  userId: string;
  sql: string;
  ddl?: string;
  dialect: string;
  riskScore: number;
}

// Best-effort "first table name" from FROM / UPDATE / INTO for the default title.
function firstTableName(sql: string): string {
  const m = /\b(?:from|update|into|table)\s+["'`]?([a-zA-Z_][\w.]*)/i.exec(sql);
  return m ? m[1].split('.').pop()! : '';
}

export function SaveQueryButton({ userId, sql, ddl, dialect, riskScore }: Props) {
  const { team } = useTeam();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [share, setShare] = useState(false);
  const [saved, setSaved] = useState(false);

  const start = () => {
    const t = firstTableName(sql);
    setTitle(t ? `${t} query` : 'Untitled query');
    setSaved(false);
    setOpen(true);
  };

  const submit = async () => {
    const ok = await saveQuery(
      {
        userId,
        teamId: share ? team?.id ?? null : null,
        title: title.trim() || 'Untitled query',
        sql,
        ddl,
        dialect,
        tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
        lastRiskScore: riskScore,
        isTeamShared: share,
      },
      getSupabase(),
    );
    if (ok) {
      setSaved(true);
      setTimeout(() => setOpen(false), 900);
    }
  };

  return (
    <span style={{ position: 'relative' }}>
      <button type="button" onClick={start} style={btn}>Save query</button>
      {open && (
        <div style={pop}>
          <div style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 6 }}>Save to your library</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={inp} />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (comma-separated)" style={inp} />
          {team && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#a1a1aa', margin: '6px 0' }}>
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with {team.name}
            </label>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" onClick={() => void submit()} style={btn}>{saved ? '✓ Saved' : 'Save'}</button>
            <button type="button" onClick={() => setOpen(false)} style={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </span>
  );
}

const btn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 5, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const cancel: React.CSSProperties = { background: 'transparent', color: '#a1a1aa', border: '1px solid #3f3f46', borderRadius: 5, padding: '5px 12px', fontSize: 12, cursor: 'pointer' };
const pop: React.CSSProperties = { position: 'absolute', top: 30, right: 0, zIndex: 50, width: 260, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' };
const inp: React.CSSProperties = { width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '6px 8px', fontSize: 12, marginBottom: 6 };
