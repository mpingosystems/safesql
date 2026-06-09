import { LegalShell, LegalSection, P, UL } from '../components/LegalShell';

// /terms — Terms of Service. Static content page.
export function TermsPage() {
  return (
    <LegalShell
      title="Terms of Service"
      meta='Effective date: June 8, 2026 · Mpingo Systems LLC ("SafeSQL Pro", "we", "us") · legal@safesqlpro.dev'
    >
      <LegalSection title="1 — Acceptance">
        <P>
          By creating an account or using SafeSQL Pro, you agree to these Terms of Service. If you are
          using SafeSQL Pro on behalf of an organization, you represent that you have authority to bind
          that organization to these terms.
        </P>
      </LegalSection>

      <LegalSection title="2 — Description of service">
        <P>
          SafeSQL Pro is a pre-execution SQL validation platform that analyzes SQL queries for semantic
          errors, logic risks, and potential data integrity issues before execution. The service
          includes a web editor, REST API, GitHub Action, CLI tool, and associated features described at
          safesqlpro.dev.
        </P>
      </LegalSection>

      <LegalSection title="3 — Accounts and access">
        <P>3.1 You are responsible for maintaining the confidentiality of your account credentials and API keys.</P>
        <P>3.2 You must not share API keys across multiple organizations or use a single Free tier account to circumvent usage limits.</P>
        <P>3.3 We reserve the right to suspend or terminate accounts that violate these terms.</P>
      </LegalSection>

      <LegalSection title="4 — Acceptable use">
        <P>You may not use SafeSQL Pro to:</P>
        <UL
          items={[
            "Attempt to gain unauthorized access to our systems or other users' data",
            'Reverse engineer the validation engine or attempt to extract proprietary detection logic',
            'Use the service in a way that violates applicable laws',
            'Submit SQL queries or schemas containing credentials, private keys, or other secrets',
            'Resell or sublicense access to the service without written permission',
          ]}
        />
      </LegalSection>

      <LegalSection title="5 — Subscription and payment">
        <P>5.1 Paid plans are billed monthly or annually as selected at checkout via Stripe.</P>
        <P>5.2 Annual plans are non-refundable after 14 days. Monthly plans may be cancelled at any time; access continues until the end of the current billing period.</P>
        <P>5.3 We reserve the right to change pricing with 30 days notice. Existing annual subscribers are protected from price changes until their renewal date.</P>
        <P>5.4 Free tier: 50 validations per month. Overages are charged at $0.10 per validation.</P>
      </LegalSection>

      <LegalSection title="6 — Data and privacy">
        <P>
          Your use of SafeSQL Pro is governed by our Privacy Policy at{' '}
          <a href="#/privacy" style={{ color: '#a78bfa' }}>safesqlpro.dev/privacy</a>. For enterprise
          customers processing personal data, our Data Processing Agreement at{' '}
          <a href="#/dpa" style={{ color: '#a78bfa' }}>safesqlpro.dev/dpa</a> governs data processing
          activities.
        </P>
      </LegalSection>

      <LegalSection title="7 — Intellectual property">
        <P>7.1 SafeSQL Pro and its underlying validation engine, detection rules, and software are owned by Mpingo Systems LLC.</P>
        <P>7.2 You retain ownership of all SQL queries, schemas, and data you submit to SafeSQL Pro.</P>
        <P>7.3 You grant us a limited license to process your queries and schemas solely to provide the service.</P>
      </LegalSection>

      <LegalSection title="8 — Disclaimer of warranties">
        <P>SafeSQL Pro is provided "as is." We do not warrant that:</P>
        <UL
          items={[
            'The service will be uninterrupted or error-free',
            'All SQL errors will be detected (false negatives may occur)',
            'Validation results constitute legal or compliance advice',
          ]}
        />
        <P>
          SafeSQL Pro is a development aid — it does not replace human review, testing, or professional
          database administration.
        </P>
      </LegalSection>

      <LegalSection title="9 — Limitation of liability">
        <P>
          To the maximum extent permitted by law, Mpingo Systems LLC shall not be liable for any
          indirect, incidental, special, or consequential damages, including lost profits or data loss,
          arising from use of SafeSQL Pro. Our total liability shall not exceed the amount you paid us in
          the 12 months preceding the claim.
        </P>
      </LegalSection>

      <LegalSection title="10 — Governing law">
        <P>
          These terms are governed by the laws of North Carolina, USA. Disputes shall be resolved in the
          courts of North Carolina.
        </P>
      </LegalSection>

      <LegalSection title="11 — Changes to terms">
        <P>
          We will notify users of material changes via email and by updating the effective date.
          Continued use constitutes acceptance.
        </P>
      </LegalSection>

      <LegalSection title="12 — Contact">
        <P>Mpingo Systems LLC<br />legal@safesqlpro.dev<br />North Carolina, USA</P>
      </LegalSection>
    </LegalShell>
  );
}
