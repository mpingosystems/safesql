import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import './index.css';
import App from './App.tsx';
import { SupabaseAuthBridge } from './components/SupabaseAuthBridge';

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const root = createRoot(document.getElementById('root')!);

if (!clerkPubKey) {
  // Render the app un-authed when Clerk isn't configured. The editor and
  // sandbox work without auth; only the persistence layer (B3+) needs it.
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={clerkPubKey} afterSignOutUrl="/">
        <SupabaseAuthBridge />
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
