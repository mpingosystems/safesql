import { useEffect, useState, lazy, Suspense } from 'react';
import { LandingPage, PricingSection } from './pages/Landing';
// Lazy: the editor page pulls in Monaco (@monaco-editor/react + CDN runtime).
// Splitting it out keeps Monaco off the landing/pricing/legal routes so it
// doesn't compete with Clerk initialization on first paint.
const EditorPage = lazy(() => import('./pages/Editor').then((m) => ({ default: m.EditorPage })));
import { ShareViewPage } from './pages/ShareView';
import { AnalyticsPage } from './pages/Analytics';
import { SettingsPage } from './pages/Settings';
import { TeamAnalyticsPage } from './pages/TeamAnalytics';
import { ApprovalInboxPage } from './pages/ApprovalInbox';
import { CompliancePage } from './pages/Compliance';
import { AuditLogPage } from './pages/AuditLog';
import { CustomRulesPage } from './pages/CustomRules';
import { BlogPage } from './pages/Blog';
import { TeamSetupPage } from './pages/TeamSetup';
import { TeamMembersPage } from './pages/TeamMembers';
import { JoinTeamPage } from './pages/JoinTeam';
import { QueryLibraryPage } from './pages/QueryLibrary';
import { LaunchPage } from './pages/LaunchPage';
import { PrivacyPage } from './pages/Privacy';
import { TermsPage } from './pages/Terms';
import { SecurityPage } from './pages/Security';
import { DPAPage } from './pages/DPA';
import { SubProcessorsPage } from './pages/SubProcessors';

type Route =
  | 'landing' | 'editor' | 'pricing' | 'share' | 'analytics' | 'settings'
  | 'team-analytics' | 'team-approvals' | 'team-audit' | 'compliance' | 'team-rules' | 'blog'
  | 'team-setup' | 'team-members' | 'team-join' | 'library' | 'launch'
  | 'privacy' | 'terms' | 'security' | 'dpa' | 'sub-processors';

function routeFromLocation(): Route {
  // New short-URL permalink is a real path: /v/{id} (served via _redirects SPA
  // fallback). Legacy hash permalink (#/v/<payload>) is handled below.
  if (/^\/v\/[^/]+/.test(window.location.pathname)) return 'share';
  const h = window.location.hash.replace(/^#/, '').replace(/\?.*$/, '');
  if (h.startsWith('/editor')) return 'editor';
  if (h.startsWith('/team/analytics')) return 'team-analytics';
  if (h.startsWith('/team/approvals')) return 'team-approvals';
  if (h.startsWith('/team/audit')) return 'team-audit';
  if (h.startsWith('/team/rules')) return 'team-rules';
  if (h.startsWith('/team/members')) return 'team-members';
  if (h.startsWith('/team/join')) return 'team-join';
  if (h.startsWith('/team/setup')) return 'team-setup';
  if (h.startsWith('/library')) return 'library';
  if (h.startsWith('/launch')) return 'launch';
  if (h.startsWith('/privacy')) return 'privacy';
  if (h.startsWith('/terms')) return 'terms';
  if (h.startsWith('/security')) return 'security';
  if (h.startsWith('/sub-processors')) return 'sub-processors';
  if (h.startsWith('/dpa')) return 'dpa';
  if (h.startsWith('/compliance')) return 'compliance';
  if (h.startsWith('/blog')) return 'blog';
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
      return (
        <Suspense fallback={<RouteLoading label="Loading editor…" />}>
          <EditorPage />
        </Suspense>
      );
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
    case 'team-rules':
      return <CustomRulesPage />;
    case 'team-setup':
      return <TeamSetupPage />;
    case 'team-members':
      return <TeamMembersPage />;
    case 'team-join':
      return <JoinTeamPage />;
    case 'library':
      return <QueryLibraryPage />;
    case 'launch':
      return <LaunchPage />;
    case 'privacy':
      return <PrivacyPage />;
    case 'terms':
      return <TermsPage />;
    case 'security':
      return <SecurityPage />;
    case 'dpa':
      return <DPAPage />;
    case 'sub-processors':
      return <SubProcessorsPage />;
    case 'blog':
      return <BlogPage />;
    default:
      return <LandingPage />;
  }
}

function RouteLoading({ label }: { label: string }) {
  return (
    <div
      style={{
        background: '#09090b',
        color: '#a1a1aa',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
      }}
    >
      {label}
    </div>
  );
}

function PricingStub() {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: '24px 0' }}>
      <div style={{ padding: '0 32px' }}>
        <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Back to home</a>
      </div>
      <PricingSection />
    </div>
  );
}

export default App;
