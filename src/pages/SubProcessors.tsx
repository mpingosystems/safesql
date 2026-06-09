import { LegalShell, P, LegalTable } from '../components/LegalShell';

// /sub-processors — standalone sub-processor list for enterprise procurement.
export function SubProcessorsPage() {
  return (
    <LegalShell
      title="Sub-processors"
      subtitle="The third-party services SafeSQL Pro uses to process data on your behalf."
      meta="Last updated: June 8, 2026 · Changes are announced with 30 days notice."
    >
      <LegalTable
        headers={['Name', 'Purpose', 'Location', 'Website', 'Data processed']}
        rows={[
          ['Clerk Inc.', 'Authentication', 'USA', link('https://clerk.com', 'clerk.com'), 'Email, name, auth tokens'],
          ['Supabase Inc.', 'Database storage', 'USA (AWS)', link('https://supabase.com', 'supabase.com'), 'Account data, validation history, encrypted credentials'],
          ['Cloudflare Inc.', 'CDN, Workers, Pages', 'USA/Global', link('https://cloudflare.com', 'cloudflare.com'), 'Request metadata, validation processing'],
          ['Stripe Inc.', 'Payment processing', 'USA', link('https://stripe.com', 'stripe.com'), 'Billing details, subscription status'],
          ['Resend Inc.', 'Transactional email', 'USA', link('https://resend.com', 'resend.com'), 'Email address, message content'],
          ['Anthropic PBC', 'AI explanations (Pro+)', 'USA', link('https://anthropic.com', 'anthropic.com'), 'Detected issue + minimal context (not full queries)'],
        ]}
      />
      <P>
        This list mirrors Article 5 of our{' '}
        <a href="#/dpa" style={{ color: '#a78bfa' }}>Data Processing Agreement</a>. For questions, contact
        privacy@safesqlpro.dev.
      </P>
    </LegalShell>
  );
}

function link(href: string, label: string) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>{label}</a>
  );
}
