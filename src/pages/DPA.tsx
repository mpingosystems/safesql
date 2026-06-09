import { LegalShell, LegalSection, P, UL, LegalTable } from '../components/LegalShell';

// /dpa — Data Processing Agreement (GDPR Article 28). Static content page.
export function DPAPage() {
  return (
    <LegalShell title="Data Processing Agreement" meta="Effective date: June 8, 2026">
      <P>
        This Data Processing Agreement ("DPA") forms part of the Terms of Service between Mpingo Systems
        LLC ("Processor") and the customer ("Controller").
      </P>

      <LegalSection title="Article 1 — Definitions">
        <P>
          "Personal Data" means any information relating to an identified or identifiable natural person
          processed by SafeSQL Pro on behalf of the Controller.
        </P>
        <P>
          "Processing" means any operation performed on Personal Data including collection, storage,
          analysis, and deletion.
        </P>
        <P>"Sub-processor" means any third party engaged by SafeSQL Pro to process Personal Data.</P>
      </LegalSection>

      <LegalSection title="Article 2 — Subject matter and duration">
        <P>
          SafeSQL Pro processes Personal Data on behalf of the Controller for the purpose of providing SQL
          validation services as described in the Terms of Service. Processing continues for the duration
          of the subscription.
        </P>
      </LegalSection>

      <LegalSection title="Article 3 — Nature and purpose of processing">
        <P>SafeSQL Pro processes:</P>
        <UL
          items={[
            'SQL queries submitted for validation (may contain field names or filter values referencing personal data)',
            'DDL schema definitions (table and column names)',
            'User account data (email, name)',
            'Usage analytics (validation counts, feature usage)',
          ]}
        />
        <P>Purpose: provision of pre-execution SQL validation services.</P>
      </LegalSection>

      <LegalSection title="Article 4 — Processor obligations">
        <P>SafeSQL Pro shall:</P>
        <P>4.1 Process Personal Data only on documented instructions from the Controller (as defined by use of the service).</P>
        <P>4.2 Ensure personnel authorized to process Personal Data are bound by confidentiality obligations.</P>
        <P>
          4.3 Implement appropriate technical and organizational security measures (see Security page:{' '}
          <a href="#/security" style={{ color: '#a78bfa' }}>safesqlpro.dev/security</a>).
        </P>
        <P>4.4 Not engage sub-processors without authorization.</P>
        <P>4.5 Assist the Controller in responding to data subject rights requests.</P>
        <P>4.6 Delete or return all Personal Data upon termination of the agreement, within 30 days of written request.</P>
        <P>4.7 Notify the Controller of any Personal Data breach within 72 hours of becoming aware of it.</P>
        <P>4.8 Make available all information necessary to demonstrate compliance with this DPA.</P>
      </LegalSection>

      <LegalSection title="Article 5 — Sub-processors">
        <P>SafeSQL Pro authorizes use of the following sub-processors:</P>
        <LegalTable
          headers={['Sub-processor', 'Location', 'Purpose']}
          rows={[
            ['Clerk Inc.', 'USA', 'Authentication'],
            ['Supabase Inc.', 'USA', 'Database storage'],
            ['Cloudflare Inc.', 'USA/Global', 'Infrastructure'],
            ['Stripe Inc.', 'USA', 'Payment processing'],
            ['Resend Inc.', 'USA', 'Email delivery'],
            ['Anthropic PBC', 'USA', 'AI explanations (Pro+)'],
          ]}
        />
        <P>
          The Controller consents to these sub-processors by accepting the Terms of Service. SafeSQL Pro
          will notify the Controller of sub-processor changes with 30 days notice. See the full list at{' '}
          <a href="#/sub-processors" style={{ color: '#a78bfa' }}>safesqlpro.dev/sub-processors</a>.
        </P>
      </LegalSection>

      <LegalSection title="Article 6 — International data transfers">
        <P>
          Personal Data may be transferred to and processed in the United States. SafeSQL Pro relies on
          Standard Contractual Clauses (SCCs) where required for transfers from the EU/UK.
        </P>
      </LegalSection>

      <LegalSection title="Article 7 — Data subject rights">
        <P>
          SafeSQL Pro will assist the Controller in fulfilling data subject rights requests (access,
          rectification, erasure, portability) within the timeframes required by applicable law. Requests
          should be submitted to privacy@safesqlpro.dev.
        </P>
      </LegalSection>

      <LegalSection title="Article 8 — Security measures">
        <P>
          Technical and organizational measures are described at{' '}
          <a href="#/security" style={{ color: '#a78bfa' }}>safesqlpro.dev/security</a>. Key measures include:
        </P>
        <UL
          items={[
            'AES-256-GCM encryption for sensitive credentials',
            'TLS 1.3 for all data in transit',
            'Row-level security on all database tables',
            'SHA-256 hashing of API keys',
            '90-day log retention with access controls',
          ]}
        />
      </LegalSection>

      <LegalSection title="Article 9 — Contact">
        <P>Data Protection contact: privacy@safesqlpro.dev<br />Mpingo Systems LLC, North Carolina, USA</P>
      </LegalSection>
    </LegalShell>
  );
}
