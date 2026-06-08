import { useEffect } from 'react';
import { getPost, posts, type BlogPost } from '../blog';
import { renderMarkdown } from '../blog/markdown';
import { SITE_URL } from '../config/constants';

// Sprint 8 Part 6 — content hub. /blog lists posts; /blog/{slug} renders one.
export function BlogPage() {
  const slug = slugFromHash();
  const post = slug ? getPost(slug) : undefined;

  useEffect(() => {
    const base = 'SafeSQL Pro';
    document.title = post ? `${post.title} | ${base}` : `Blog | ${base}`;
  }, [post]);

  if (slug && !post) {
    return (
      <Shell>
        <h1 style={{ fontSize: 24 }}>Post not found</h1>
        <a href="#/blog" style={{ color: '#a78bfa' }}>← All posts</a>
      </Shell>
    );
  }

  return post ? <PostView post={post} /> : <PostList />;
}

function PostList() {
  return (
    <Shell>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>The SafeSQL Blog</h1>
      <p style={{ color: '#a1a1aa', marginTop: 0 }}>SQL correctness, fan-out joins, and the safety net under AI-generated SQL.</p>
      <div style={{ marginTop: 24 }}>
        {posts.map((p) => (
          <a key={p.slug} href={`#/blog/${p.slug}`} style={{ display: 'block', textDecoration: 'none', border: '1px solid #27272a', borderRadius: 8, padding: 18, marginBottom: 14, background: '#18181b' }}>
            <h2 style={{ fontSize: 18, color: '#e4e4e7', margin: '0 0 6px' }}>{p.title}</h2>
            <p style={{ color: '#a1a1aa', fontSize: 13.5, margin: '0 0 8px', lineHeight: 1.5 }}>{p.description}</p>
            <div style={{ color: '#71717a', fontSize: 12 }}>
              {p.publishedAt} · {p.readingMinutes} min read · {p.tags.join(', ')}
            </div>
          </a>
        ))}
      </div>
    </Shell>
  );
}

function PostView({ post }: { post: BlogPost }) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const html = renderMarkdown(post.content);
  return (
    <Shell>
      <a href="#/blog" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← All posts</a>
      <div style={{ color: '#71717a', fontSize: 12, marginTop: 16 }}>{post.publishedAt} · {post.readingMinutes} min read</div>
      <article dangerouslySetInnerHTML={{ __html: html }} style={{ marginTop: 8 }} />
      <div style={{ display: 'flex', gap: 12, marginTop: 28, borderTop: '1px solid #27272a', paddingTop: 16 }}>
        <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(post.title)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer" style={shareLink}>Share on Twitter</a>
        <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer" style={shareLink}>Share on LinkedIn</a>
      </div>
      <div style={{ marginTop: 24, background: 'linear-gradient(135deg,#1e1b4b,#0f0f10)', border: '1px solid #3f3f46', borderRadius: 8, padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Catch these bugs before they run.</div>
        <a href="#/editor" style={{ display: 'inline-block', marginTop: 10, background: '#7c3aed', color: 'white', padding: '8px 18px', borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: 13 }}>Try SafeSQL free →</a>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
        <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none' }}>SafeSQL</a>
        <a href="#/editor" style={{ color: '#71717a', textDecoration: 'none' }}>Editor</a>
      </div>
      <div style={{ maxWidth: 720, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}

function slugFromHash(): string | null {
  const m = /#\/blog\/([^/?#]+)/.exec(window.location.hash);
  return m ? m[1] : null;
}

const shareLink: React.CSSProperties = { color: '#a78bfa', fontSize: 13, textDecoration: 'none' };
