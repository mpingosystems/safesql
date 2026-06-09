import { LegalShell, LegalSection, P, SubH, UL, LegalTable } from '../components/LegalShell';

// /privacy — Privacy Policy (GDPR + CCPA). Static content page.
export function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      meta="Effective date: June 8, 2026 · Last updated: June 8, 2026 · Mpingo Systems LLC, North Carolina, USA · privacy@safesqlpro.dev"
    >
      <LegalSection title="1 — Information we collect">
        <SubH>1.1 Account information</SubH>
        <P>
          When you create an account, we collect your email address and name via Clerk
          authentication. We also receive an authentication token from your identity provider
          (Google or email/password). We do not store passwords — authentication is handled by Clerk.
        </P>
        <SubH>1.2 SQL queries and schemas</SubH>
        <P>
          When you use the SafeSQL Pro editor, your SQL queries and DDL schema statements are
          processed client-side in your browser. Queries are transmitted to our validation engine
          for analysis. We store validation results (risk score, detected issues) in our database
          associated with your account to provide history and analytics features. We do not store
          the raw SQL text of your queries beyond what is necessary to generate your validation history.
        </P>
        <SubH>1.3 Database connection credentials</SubH>
        <P>
          If you use the Schema Connector feature (Pro tier), you may provide a database connection
          string. This connection string is encrypted using AES-256-GCM before storage. The
          encryption key is stored separately in Cloudflare Workers secrets and is never stored
          alongside the encrypted credentials. We use these credentials only to introspect your
          database schema (INFORMATION_SCHEMA queries) — we do not read, copy, or store the contents
          of your tables.
        </P>
        <SubH>1.4 Usage data</SubH>
        <P>
          We collect information about how you use SafeSQL Pro, including validation counts, feature
          usage, and error rates. This data is used to improve the product and enforce tier limits.
        </P>
        <SubH>1.5 Payment information</SubH>
        <P>
          Payment processing is handled by Stripe. We do not store credit card numbers or payment
          details. We store your Stripe customer ID and subscription status.
        </P>
        <SubH>1.6 Log data</SubH>
        <P>
          Our servers automatically record certain information when you use SafeSQL Pro, including IP
          address, browser type, pages visited, and timestamps. Log data is retained for 90 days.
        </P>
      </LegalSection>

      <LegalSection title="2 — How we use your information">
        <P>We use the information we collect to:</P>
        <UL
          items={[
            'Provide, operate, and improve SafeSQL Pro',
            'Process payments and manage subscriptions',
            'Send transactional emails (receipts, validation alerts, team invitations)',
            'Enforce usage limits by tier',
            "Generate analytics about your team's SQL quality",
            'Respond to support requests',
            'Comply with legal obligations',
          ]}
        />
        <P>
          We do not sell your personal information to third parties. We do not use your SQL queries
          or schemas to train AI models. We do not share your data with advertisers.
        </P>
      </LegalSection>

      <LegalSection title="3 — Data storage and security">
        <P>
          Your data is stored in Supabase (PostgreSQL) hosted on AWS in the United States. Validation
          data is processed via Cloudflare Workers distributed globally.
        </P>
        <P>Security measures:</P>
        <UL
          items={[
            'All data in transit encrypted via TLS 1.3',
            'Database connections encrypted at rest',
            'Schema connection credentials encrypted with AES-256-GCM',
            'API keys stored as SHA-256 hashes (never in plaintext)',
            'Row-level security enforced on all database tables',
            'Access to production systems restricted to authorized personnel',
          ]}
        />
      </LegalSection>

      <LegalSection title="4 — Data retention">
        <UL
          items={[
            'Account data: retained while your account is active',
            'Validation history: retained for 12 months on Free tier, unlimited on paid tiers',
            'Shared validation permalinks: expire after 30 days',
            'Database connection credentials: deleted within 7 days of account deletion or connection removal',
            'Log data: retained for 90 days',
          ]}
        />
      </LegalSection>

      <LegalSection title="5 — Your rights">
        <P>Depending on your location, you may have the right to:</P>
        <UL
          items={[
            'Access the personal data we hold about you',
            'Correct inaccurate personal data',
            'Delete your personal data ("right to be forgotten")',
            'Export your data in a portable format',
            'Withdraw consent for optional data processing',
          ]}
        />
        <P>
          To exercise these rights, email privacy@safesqlpro.dev. We will respond within 30 days.
        </P>
      </LegalSection>

      <LegalSection title="6 — Third-party services (sub-processors)">
        <P>SafeSQL Pro uses the following third-party services:</P>
        <LegalTable
          headers={['Service', 'Purpose', 'Location']}
          rows={[
            ['Clerk', 'Authentication', 'USA'],
            ['Supabase', 'Database', 'USA (AWS)'],
            ['Cloudflare', 'CDN, Workers, Pages', 'Global'],
            ['Stripe', 'Payment processing', 'USA'],
            ['Resend', 'Transactional email', 'USA'],
            ['Anthropic', 'AI explanations (Pro tier)', 'USA'],
          ]}
        />
        <P>
          A standalone, always-current list is available at{' '}
          <a href="#/sub-processors" style={{ color: '#a78bfa' }}>safesqlpro.dev/sub-processors</a>.
        </P>
      </LegalSection>

      <LegalSection title="7 — Cookies">
        <P>
          SafeSQL Pro uses only functional cookies required for authentication and session
          management. We do not use tracking cookies, advertising cookies, or third-party analytics
          cookies.
        </P>
      </LegalSection>

      <LegalSection title="8 — GDPR (EU/UK users)">
        <P>
          For users in the European Union or United Kingdom, we process your data under the following
          legal bases:
        </P>
        <UL
          items={[
            'Contract: processing necessary to provide the service you signed up for',
            'Legitimate interests: security monitoring, fraud prevention, product improvement',
            'Consent: optional features like marketing emails',
          ]}
        />
        <P>
          SafeSQL Pro acts as a data processor when processing SQL queries and schemas that may
          contain personal data about your end users. Our Data Processing Agreement (DPA) is available
          at <a href="#/dpa" style={{ color: '#a78bfa' }}>safesqlpro.dev/dpa</a>.
        </P>
      </LegalSection>

      <LegalSection title="9 — CCPA (California users)">
        <P>
          California residents have the right to know what personal information we collect, request
          deletion, and opt out of sale (we do not sell personal information).
        </P>
      </LegalSection>

      <LegalSection title="10 — Changes to this policy">
        <P>
          We will notify users of material changes to this policy via email and by updating the
          "Last updated" date above. Continued use of SafeSQL Pro after changes constitutes acceptance
          of the updated policy.
        </P>
      </LegalSection>

      <LegalSection title="11 — Contact">
        <P>Mpingo Systems LLC<br />privacy@safesqlpro.dev<br />North Carolina, USA</P>
      </LegalSection>
    </LegalShell>
  );
}
