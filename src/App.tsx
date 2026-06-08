import { useEffect, useState } from 'react';
import { LandingPage } from './pages/Landing';
import { EditorPage } from './pages/Editor';
import { ShareViewPage } from './pages/ShareView';

type Route = 'landing' | 'editor' | 'pricing' | 'share';

function routeFromHash(): Route {
  const h = window.location.hash.replace(/^#/, '').replace(/\?.*$/, '');
  if (h.startsWith('/editor')) return 'editor';
  if (h.startsWith('/pricing')) return 'pricing';
  if (h.startsWith('/v/')) return 'share';
  return 'landing';
}

function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  switch (route) {
    case 'editor':
      return <EditorPage />;
    case 'pricing':
      return <PricingStub />;
    case 'share':
      return <ShareViewPage />;
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
