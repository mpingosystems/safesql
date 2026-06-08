// Tiny zero-dependency markdown → HTML renderer for the blog (the guardrail
// forbids adding markdown deps to the main package). Supports the subset the
// posts use: #/##/### headings, paragraphs, fenced code blocks (with light SQL
// highlighting), unordered lists, blockquotes, **bold**, `inline code`, links.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SQL_KEYWORDS =
  /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP BY|ORDER BY|HAVING|SUM|COUNT|AVG|MIN|MAX|AS|AND|OR|NOT|NULL|IS|IN|WITH|UNION|INSERT|UPDATE|DELETE|CREATE|TABLE|DISTINCT|CASE|WHEN|THEN|ELSE|END|INTERVAL|COALESCE)\b/gi;

function highlightSql(code: string): string {
  return escapeHtml(code)
    .replace(/('[^']*')/g, '<span style="color:#86efac">$1</span>')
    .replace(/(--[^\n]*)/g, '<span style="color:#71717a">$1</span>')
    .replace(SQL_KEYWORDS, '<span style="color:#c4b5fd">$1</span>');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code style="background:#18181b;border:1px solid #27272a;border-radius:3px;padding:1px 4px;font-size:0.9em">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#a78bfa">$1</a>');
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      closeList();
      const lang = line.slice(3).trim().toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // skip closing fence
      const code = buf.join('\n');
      const html = lang === 'sql' || lang === '' ? highlightSql(code) : escapeHtml(code);
      out.push(`<pre style="background:#0a0a0a;border:1px solid #27272a;border-radius:8px;padding:14px;overflow:auto;font-size:13px;line-height:1.5"><code style="font-family:'JetBrains Mono',Menlo,monospace">${html}</code></pre>`);
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      const size = level === 1 ? 28 : level === 2 ? 20 : 16;
      out.push(`<h${level} style="font-size:${size}px;margin:24px 0 10px;line-height:1.3">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      if (!listOpen) {
        out.push('<ul style="padding-left:20px;line-height:1.7">');
        listOpen = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      closeList();
      out.push(`<blockquote style="border-left:3px solid #7c3aed;padding-left:12px;color:#a1a1aa;margin:12px 0">${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }

    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }

    closeList();
    out.push(`<p style="line-height:1.7;color:#d4d4d8;margin:10px 0">${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join('\n');
}
