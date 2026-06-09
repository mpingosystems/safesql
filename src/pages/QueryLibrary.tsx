import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { getSupabase } from '../services/supabaseClient';
import {
  deleteQuery,
  getMyQueries,
  getTeamQueries,
  updateQuery,
  type SavedQuery,
} from '../services/queryLibrary';

// Sprint 9 Part 3 — Query Library at /library. Two tabs (My / Team), search,
// and per-card open / share / delete. Opening a query bounces to the editor with
// its SQL + DDL preloaded via sessionStorage.
export function QueryLibraryPage() {
  const { appUser } = useAppUser();
  const { team } = useTeam();
  const isTeam = !!appUser && ['team', 'business', 'enterprise'].includes(appUser.plan);

  const [tab, setTab] = useState<'mine' | 'team'>('mine');
  const [mine, setMine] = useState<SavedQuery[]>([]);
  const [teamQueries, setTeamQueries] = useState<SavedQuery[]>([]);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftTags, setDraftTags] = useState('');

  const refresh = useCallback(async () => {
    if (!appUser?.id) return;
    const client = getSupabase();
    setMine(await getMyQueries(appUser.id, client));
    if (team?.id) setTeamQueries(await getTeamQueries(team.id, client));
  }, [appUser?.id, team?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (q: SavedQuery) => {
    try {
      window.sessionStorage.setItem('safesql.preloadSql', q.sql);
      if (q.ddl) window.sessionStorage.setItem('safesql.preloadDdl', q.ddl);
    } catch {
      /* sessionStorage may be unavailable */
    }
    window.location.hash = '#/editor';
  };

  const toggleShare = async (q: SavedQuery) => {
    await updateQuery(q.id, { isTeamShared: !q.is_team_shared, teamId: team?.id ?? null }, getSupabase());
    await refresh();
  };

  const remove = async (q: SavedQuery) => {
    await deleteQuery(q.id, getSupabase());
    await refresh();
  };

  const startEdit = (q: SavedQuery) => {
    setEditingId(q.id);
    setDraftTitle(q.title);
    setDraftTags((q.tags ?? []).join(', '));
  };

  const saveEdit = async (q: SavedQuery) => {
    await updateQuery(
      q.id,
      { title: draftTitle.trim() || q.title, tags: draftTags.split(',').map((s) => s.trim()).filter(Boolean) },
      getSupabase(),
    );
    setEditingId(null);
    await refresh();
  };

  const source = tab === 'mine' ? mine : teamQueries;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((q) =>
      [q.title, q.description ?? '', ...(q.tags ?? [])].join(' ').toLowerCase().includes(needle),
    );
  }, [source, search]);

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Query Library</h1>
        <a href="#/editor" style={{ background: '#7c3aed', color: 'white', borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>Save current query →</a>
      </div>
      <p style={{ color: '#a1a1aa', fontSize: 13 }}>Your validated queries — reuse them, tag them, share them with the team. Validate in the editor, then click "Save query".</p>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Tab active={tab === 'mine'} onClick={() => setTab('mine')}>My queries</Tab>
        {isTeam && <Tab active={tab === 'team'} onClick={() => setTab('team')}>Team queries</Tab>}
      </div>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by title, description, or tag…"
        style={{ width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 6, padding: '8px 10px', fontSize: 13, margin: '14px 0' }}
      />

      {filtered.length === 0 ? (
        <p style={{ color: '#52525b', fontSize: 13 }}>
          {tab === 'team'
            ? 'No team-shared queries yet.'
            : 'No saved queries yet. Validate a query in the editor, then "Save current query".'}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {filtered.map((q) => (
            <div key={q.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                {editingId === q.id ? (
                  <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} style={editInp} autoFocus />
                ) : (
                  <button type="button" onClick={() => open(q)} style={titleBtn}>{q.title}</button>
                )}
                {q.last_risk_score != null && <ScoreBadge score={q.last_risk_score} />}
              </div>
              {q.description && <div style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 3 }}>{q.description}</div>}
              {editingId === q.id ? (
                <input value={draftTags} onChange={(e) => setDraftTags(e.target.value)} placeholder="tags, comma, separated" style={{ ...editInp, marginTop: 8 }} />
              ) : (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {(q.tags ?? []).map((tg) => <span key={tg} style={tag}>{tg}</span>)}
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, marginTop: 10, alignItems: 'center', fontSize: 12 }}>
                <button type="button" onClick={() => open(q)} style={linkBtn}>Open in editor →</button>
                {tab === 'mine' && (
                  editingId === q.id ? (
                    <>
                      <button type="button" onClick={() => void saveEdit(q)} style={linkBtn}>Save</button>
                      <button type="button" onClick={() => setEditingId(null)} style={{ ...linkBtn, color: '#71717a' }}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => startEdit(q)} style={{ ...linkBtn, color: '#71717a' }}>Edit</button>
                  )
                )}
                {tab === 'mine' && isTeam && (
                  <label style={{ color: '#a1a1aa', cursor: 'pointer' }}>
                    <input type="checkbox" checked={q.is_team_shared} onChange={() => void toggleShare(q)} /> Share with team
                  </label>
                )}
                <span style={{ color: '#52525b', marginLeft: 'auto' }}>
                  {q.last_validated_at ? `validated ${q.last_validated_at.slice(0, 10)}` : ''}
                </span>
                {tab === 'mine' && <button type="button" onClick={() => void remove(q)} style={delBtn}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

function ScoreBadge({ score }: { score: number }) {
  // SAFE (green) / REVIEW (amber) / RISKY (red), with the numeric score.
  const { color, label } =
    score <= 40
      ? { color: '#ef4444', label: 'RISKY' }
      : score <= 69
        ? { color: '#f59e0b', label: 'REVIEW' }
        : score <= 84
          ? { color: '#eab308', label: 'REVIEW' }
          : { color: '#22c55e', label: 'SAFE' };
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, border: `1px solid ${color}`, color, fontSize: 11, fontWeight: 700 }}>
      {label} · {score}
    </span>
  );
}
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ background: active ? '#7c3aed' : 'transparent', color: active ? 'white' : '#a1a1aa', border: '1px solid ' + (active ? '#7c3aed' : '#3f3f46'), borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}>{children}</button>
  );
}
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Editor</a>
      <div style={{ maxWidth: 760, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}
const card: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 14, background: '#18181b' };
const titleBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: '#e4e4e7', fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: 0, textAlign: 'left' };
const tag: React.CSSProperties = { background: '#27272a', color: '#a78bfa', borderRadius: 4, padding: '2px 8px', fontSize: 11 };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: 12, padding: 0 };
const delBtn: React.CSSProperties = { background: 'transparent', color: '#ef4444', border: '1px solid #3f3f46', borderRadius: 5, padding: '3px 10px', fontSize: 12, cursor: 'pointer' };
const editInp: React.CSSProperties = { flex: 1, background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 5, padding: '5px 8px', fontSize: 13 };
