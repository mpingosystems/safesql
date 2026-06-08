import { useEffect, useState } from 'react';
import { LandingPage } from './pages/Landing';
import { EditorPage } from './pages/Editor';
import { ShareViewPage } from './pages/ShareView';
import { AnalyticsPage } from './pages/Analytics';
import { SettingsPage } from './pages/Settings';
import { TeamAnalyticsPage } from './pages/TeamAnalytics';
import { ApprovalInboxPage } from './pages/ApprovalInbox';
import { CompliancePage } from './pages/Compliance';
import { AuditLogPage } from './pages/AuditLog';

type Route =
  | 'landing' | 'editor' | 'pricing' | 'share' | 'analytics' | 'settings'
  | 'team-analytics' | 'team-approvals' | 'team-audit' | 'compliance';

function routeFromLocation(): Route {
  // New short-URL permalink is a real path: /v/{id} (served via _redirects SPA
  // fallback). Legacy hash permalink (#/v/<payload>) is handled below.
  if (/^\/v\/[^/]+/.test(window.location.pathname)) return 'share';
  const h = window.location.hash.replace(/^#/, '').replace(/\?.*$/, '');
  if (h.startsWith('/editor')) return 'editor';
  if (h.startsWith('/team/analytics')) return 'team-analytics';
  if (h.startsWith('/team/approvals')) return 'team-approvals';
  if (h.startsWith('/team/audit')) return 'team-audit';
  if (h.startsWith('/compliance')) return 'compliance';
  if (h.startsWith('/analytics')) return 'analytics';
  if (h.startsWith('/settings')) return 'settings';
  if (h.startsWith('/pricing')) return 'pricing';
  if (h.startsWith('/v/')) return 'share';
  return 'landing';
}

function App() {
  const [route, setRoute] = useState<Route>(routeFromLocation);

  useEffect(() => {
    const onChange = () => setRoute(routeFromLocation());
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);

  switch (route) {
    case 'editor':
      return <EditorPage />;
    case 'pricing':
      return <PricingStub />;
    case 'share':
      return <ShareViewPage />;
    case 'analytics':
      return <AnalyticsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'team-analytics':
      return <TeamAnalyticsPage />;
    case 'team-approvals':
      return <ApprovalInboxPage />;
    case 'team-audit':
      return <AuditLogPage />;
    case 'compliance':
      return <CompliancePage />;
    default:
      return <LandingPage />;
  }
}

function PricingStub() {
  return (
    <div
      style={{
        background: '#09090b',
        color: '#e4e4e7',
        minHeight: '100vh',
        padding: '60px 32px',
        textAlign: 'center',
      }}
    >
      <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>
        ← Back to home
      </a>
      <h1 style={{ fontSize: 36, marginTop: 30 }}>Pricing</h1>
      <p style={{ color: '#a1a1aa', marginTop: 16 }}>
        See pricing on the <a href="#/" style={{ color: '#a78bfa' }}>landing page</a>.
        Stripe checkout coming in Step 14.
      </p>
    </div>
  );
}

export default App;
