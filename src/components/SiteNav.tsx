import { AuthControls } from './AuthControls';

// Shared marketing-site nav.
//
// Previously each page hand-rolled this: Landing had the full bar, while
// /how-to and /benchmark had only a "← SafeSQL Pro" back-link. That meant there
// was no nav link to mark active on the very pages a nav would help you leave.
// One component, one active-state rule, used by all three.

export type NavRoute = 'landing' | 'how-to' | 'consulting' | 'benchmark' | 'pricing';

const LINKS: Array<{ label: string; href: string; route: NavRoute }> = [
  { label: 'How To', href: '#/how-to', route: 'how-to' },
  { label: 'Consulting', href: '#/consulting', route: 'consulting' },
  { label: 'Benchmark', href: '#/benchmark', route: 'benchmark' },
  { label: 'Pricing', href: '#/pricing', route: 'pricing' },
];

const base: React.CSSProperties = {
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 600,
  paddingBottom: 2,
};

/** Active link: brightened and underlined, so the state survives a greyscale
 *  screenshot and does not rely on colour alone. */
function linkStyle(active: boolean): React.CSSProperties {
  return {
    ...base,
    color: active ? '#e4e4e7' : '#a1a1aa',
    borderBottom: active ? '2px solid #7c3aed' : '2px solid transparent',
  };
}

const ctaButton: React.CSSProperties = {
  background: '#7c3aed',
  color: 'white',
  textDecoration: 'none',
  padding: '7px 14px',
  borderRadius: 5,
  fontSize: 13,
  fontWeight: 600,
};

export function SiteNav({ current }: { current: NavRoute }) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '14px 32px',
        borderBottom: '1px solid #27272a',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <a
          href="#/"
          style={{ fontWeight: 700, fontSize: 18, color: '#a78bfa', textDecoration: 'none' }}
        >
          SafeSQL Pro
        </a>
        <span style={{ fontSize: 11, color: '#52525b' }}>v0.11.0</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        {/* How To · Consulting sit before the editor CTA; Benchmark · Pricing after. */}
        {LINKS.slice(0, 2).map((l) => (
          <a
            key={l.route}
            href={l.href}
            aria-current={current === l.route ? 'page' : undefined}
            style={linkStyle(current === l.route)}
          >
            {l.label}
          </a>
        ))}
        <a href="#/editor" style={ctaButton}>
          Open Editor →
        </a>
        {LINKS.slice(2).map((l) => (
          <a
            key={l.route}
            href={l.href}
            aria-current={current === l.route ? 'page' : undefined}
            style={linkStyle(current === l.route)}
          >
            {l.label}
          </a>
        ))}
        <AuthControls />
      </div>
    </nav>
  );
}
