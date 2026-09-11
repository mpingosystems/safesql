import { SiteNav } from '../components/SiteNav';
import { UseCaseTabs } from '../components/howto/UseCaseTabs';
import type { UseCase } from '../components/howto/types';

// Sprint 5D — /how-to. Five use cases, one per reader, each a copy-pasteable
// path from nothing to a working guardrail.
//
// Every command, flag, hook id and package name below is taken from the shipped
// artifact (cli/README.md, .pre-commit-hooks.yaml, action/action.yml,
// dbt-safesql/setup.py, the VS Code Marketplace id) — not from memory.
//
// NOTE ON THE ACTION ORG: it is `mpingosystems/safesql@v1`, matching the git
// remote. action/README.md currently documents `emkwambe/safesql@v1`, which does
// not resolve; that README still needs fixing separately.

const DEFAULT_TAB = 'analytics-engineer' as const;

const USE_CASES: UseCase[] = [
  {
    id: 'dbt',
    label: 'dbt Engineer',
    persona: 'dbt engineer',
    problem:
      'Staging models join. Marts aggregate. A grain mistake in staging surfaces as a wrong number three models downstream, and dbt tests do not check whether a SUM was inflated by a join.',
    steps: [
      {
        title: 'Install the validator beside dbt',
        body:
          'It is an ordinary Python CLI, not a dbt package. dbt packages carry Jinja and SQL only and cannot make HTTP calls or shell out, so the validator has to run next to dbt rather than inside it.',
        snippets: [
          {
            lang: 'bash',
            caption: 'PyPI',
            code: `pip install dbt-safesql`,
          },
        ],
      },
      {
        title: 'Run it across the whole project',
        body:
          'safesql-dbt walks models/**/*.sql, strips dbt Jinja, resolves ref() and source() to relation names, and builds a schema from schema.yml and sources.yml. It exits nonzero when a model scores below the threshold.',
        snippets: [
          {
            lang: 'bash',
            caption: 'Project-wide, dbt-aware',
            code: `safesql-dbt --threshold=70

# report only, never fail the run
safesql-dbt --threshold=70 --warn-only`,
          },
          {
            lang: 'text',
            isOutput: true,
            code: `models/marts/revenue_by_plan.sql   score: 25   AGGREGATE_OVER_FANOUT_JOIN
models/staging/stg_payments.sql    score: 100
2 models checked, 1 below threshold`,
          },
        ],
      },
      {
        title: 'Block it before the commit',
        body:
          'Use safesql-validate for dbt projects — it ignores the filenames pre-commit passes and walks the whole project, because a model’s correctness depends on refs and column types declared elsewhere. safesql-sql is the file-scoped hook for ordinary SQL repos.',
        snippets: [
          {
            lang: 'yaml',
            caption: '.pre-commit-config.yaml',
            code: `repos:
  - repo: https://github.com/mpingosystems/safesql
    rev: dbt-safesql-v0.2.0
    hooks:
      - id: safesql-validate   # project-wide, dbt-aware`,
          },
        ],
      },
      {
        title: 'Know what it does not do',
        body:
          'A dbt hook cannot enforce this. on-run-start executes its argument as SQL against the warehouse, and dbt’s Jinja sandbox has no HTTP client or shell — so a hook or macro can log but never block. Real enforcement is pre-commit or CI. SafeSQL also validates each model independently; it does not yet track grain across a ref() boundary, so a fan-out introduced in staging and aggregated in a mart is checked as two separate queries.',
      },
    ],
    outcome:
      'Every model checked against its own schema before it builds, and a failing exit code wherever you want the gate — commit, CI, or a shell step before dbt run.',
  },
  {
    id: 'ai-sql',
    label: 'AI SQL User',
    persona: 'Cursor / Copilot / text-to-SQL user',
    problem:
      'The assistant writes a query in two seconds. It parses, it runs, it returns a number. Benchmarks put roughly one in four AI-generated queries as semantically wrong — not broken, wrong — and review is now the bottleneck.',
    steps: [
      {
        title: 'Put the check where the SQL is written',
        body:
          'The VS Code extension validates .sql files on save and marks findings inline, so a generated query is checked in the same second it lands in the editor.',
        snippets: [
          {
            lang: 'bash',
            caption: 'VS Code Marketplace',
            code: `code --install-extension mpingosystems.safesql-pro`,
          },
        ],
      },
      {
        title: 'Point it at your schema',
        body:
          'Set safesql.schemaFile to a DDL file in your workspace. This is what turns on hallucinated-column and hallucinated-table detection — the failure mode most specific to generated SQL, where a plausible column name simply does not exist.',
        snippets: [
          {
            lang: 'json',
            caption: '.vscode/settings.json',
            code: `{
  "safesql.schemaFile": "schema/production.sql",
  "safesql.dialect": "postgresql",
  "safesql.validateOnSave": true,
  "safesql.threshold": 70
}`,
          },
        ],
      },
      {
        title: 'Let an agent check its own output',
        body:
          'The npm SDK wraps the same API, so a generation loop can validate before it returns: draft, check, repair, check, execute. Findings come back with the offending clause, table and column, which is enough for a model to fix its own query.',
        snippets: [
          {
            lang: 'bash',
            code: `npm install @safesqlpro/sdk`,
          },
          {
            lang: 'text',
            caption: 'Usage',
            code: `new SafeSQLClient({ apiKey }).validate({ sql, ddl, dialect, threshold })
  -> { valid, score, verdict, issues[], detectorsRun[] }`,
          },
        ],
      },
      {
        title: 'Detection never uses AI',
        body:
          'The detection layer is deterministic AST rules — a rule fires or it does not, so it cannot hallucinate a finding about a hallucinated query. AI is used only to explain a finding in plain English after the rules have decided, and everything works with it switched off.',
      },
    ],
    outcome:
      'Generated SQL gets a deterministic second opinion before a human reads it, at ~0.7 ms per query — so review time goes on logic instead of arithmetic.',
  },
  {
    id: 'analytics-engineer',
    label: 'Analytics Engineer',
    persona: 'analytics engineer',
    problem:
      'A query ran clean, returned a plausible number, and shipped. Six weeks later finance says the quarter does not reconcile — and you have to work out which model inherited it.',
    steps: [
      {
        title: 'Start with a query you already shipped',
        body:
          'No install and no account. Paste a query and its DDL into the editor and validate. Pick something already in production rather than a toy query — the point is to find out what is currently running.',
        snippets: [
          {
            lang: 'sql',
            caption: 'The shape that causes it',
            code: `SELECT c.plan, SUM(p.amount) AS total_revenue
FROM customers c
JOIN subscriptions s ON s.customer_id = c.id
JOIN payments p ON p.customer_id = c.id
GROUP BY c.plan;`,
          },
          {
            lang: 'text',
            isOutput: true,
            code: `AGGREGATE_OVER_FANOUT_JOIN   error   score 25/100
SUM(amount) is inflated by the join to "subscriptions".
Fix: pre-aggregate payments before joining.`,
          },
        ],
      },
      {
        title: 'Give it your schema',
        body:
          'Ten of the 35 detectors are schema-aware — hallucinated columns, nullable-FK join drops, integer division, NOT IN over nullables. Without DDL they cannot fire, and their silence looks like a clean bill of health. Paste your CREATE TABLE statements, or connect PostgreSQL, BigQuery or Snowflake in Settings.',
      },
      {
        title: 'Read the synthetic proof, not just the warning',
        body:
          'SafeSQL generates schema-matched synthetic rows, runs your query on them in-browser, and shows the actual row count before and after the join. That turns "this might be wrong" into a number you can take to whoever owns the dashboard.',
      },
      {
        title: 'Move it into your terminal',
        body:
          'Same 35 detectors, no network call. Exit code 1 on an error, so it composes with anything. Add --fail-on-warnings when you want the stricter gate.',
        snippets: [
          {
            lang: 'bash',
            caption: 'Validate a file',
            code: `npx safesql validate models/revenue.sql --schema schema.sql

# machine-readable, for scripting
npx safesql validate models/revenue.sql --json`,
          },
        ],
      },
      {
        title: 'Stop it at the commit',
        body:
          'The pre-commit hook validates exactly the staged .sql files and aborts the commit on a nonzero exit. This is the cheapest place in your workflow to catch a fan-out — before it is a PR, a merge, or a dashboard.',
        snippets: [
          {
            lang: 'yaml',
            caption: '.pre-commit-config.yaml',
            code: `repos:
  - repo: https://github.com/mpingosystems/safesql
    rev: dbt-safesql-v0.2.0
    hooks:
      - id: safesql-sql        # file-scoped: the staged .sql files`,
          },
        ],
      },
    ],
    outcome:
      'The class of error that does not crash — fan-out aggregates, silent LEFT JOIN collapse, NULL semantics — gets caught at the keyboard instead of in a reconciliation meeting. Deterministic, ~0.7 ms, no AI in the detection path.',
  },
  {
    id: 'compliance',
    label: 'Compliance Team',
    persona: 'compliance / risk',
    // Deliberately scoped to what is shipped AND externally verifiable: the CI
    // pipeline and its logs. The audit log, approval workflow and CSV export
    // exist in code but depend on migrations still pending manual application,
    // so nothing here claims them.
    problem:
      'You need to demonstrate that every SQL change was checked before it reached production — and "we review carefully" is not evidence.',
    steps: [
      {
        title: 'Make the check a required status',
        body:
          'The GitHub Action runs the same 35 detectors on the SQL files changed in a pull request, entirely inside CI with no network call. It exits nonzero when a file has an error, so a failing check blocks the merge.',
        snippets: [
          {
            lang: 'yaml',
            caption: '.github/workflows/safesql.yml',
            code: `name: SafeSQL
on: [pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mpingosystems/safesql@v1
        with:
          sql_files: "models/**/*.sql"
          schema_file: "schema/production.sql"
          dialect: "postgresql"`,
          },
        ],
      },
      {
        title: 'Decide what blocks a merge',
        body:
          'By default only errors fail the job. Set fail_on_warnings to true when a warning should also stop the merge — a stricter gate is easier to defend than a documented exception.',
        snippets: [
          {
            lang: 'yaml',
            code: `        with:
          fail_on_warnings: true`,
          },
        ],
      },
      {
        title: 'Put the finding on the pull request',
        body:
          'PR-review mode posts each finding as an inline comment on the changed line, so the record of what was flagged and how it was resolved lives on the pull request itself rather than in someone’s memory. It needs a token and pull-request write permission. Set comment_mode to warn to comment without blocking.',
        snippets: [
          {
            lang: 'yaml',
            code: `permissions:
  contents: read
  pull-requests: write

# ...
      - uses: mpingosystems/safesql@v1
        with:
          mode: pr-review
          github_token: \${{ secrets.GITHUB_TOKEN }}
          comment_mode: block   # or: warn`,
          },
        ],
      },
      {
        title: 'The run log is the record',
        body:
          'Every run records the commit SHA, the files checked, the detectors that fired and the outcome, retained under your GitHub retention policy. It is produced by the pipeline rather than asserted by the team, which is what makes it usable as evidence.',
      },
    ],
    outcome:
      'The CI pipeline is your audit trail. Every SQL change validated before merge. Every PR with a finding blocked until resolved. The GitHub Action log proves what was checked and when.',
  },
  {
    id: 'engineering-lead',
    label: 'Engineering Lead',
    persona: 'engineering lead',
    problem:
      'You cannot tell whether SQL quality is getting better or worse. Review depth varies by who is on rota, and the errors that matter are the ones that do not throw.',
    steps: [
      {
        title: 'Start with one repository, in warn mode',
        body:
          'Add the Action to a single repo with fail_on_warnings off and nothing blocking. The first week is measurement: you are finding out what the current baseline is, not changing anyone’s workflow.',
        snippets: [
          {
            lang: 'yaml',
            code: `      - uses: mpingosystems/safesql@v1
        with:
          sql_files: "models/**/*.sql"
          schema_file: "schema/production.sql"`,
          },
        ],
      },
      {
        title: 'Set a threshold the team agrees with',
        body:
          'Scores follow a fixed policy: 0-40 hard error, 41-69 high-risk, 70-84 medium, 85-100 suggestion. A threshold of 70 blocks the first two bands and is the default across the CLI, the dbt runner and the hooks. Raise it once the baseline is clean.',
        snippets: [
          {
            lang: 'bash',
            code: `safesql-dbt --threshold=70
npx safesql validate query.sql --fail-on-warnings`,
          },
        ],
      },
      {
        title: 'Push it left once it is trusted',
        body:
          'CI tells you a PR is wrong. The pre-commit hook and the VS Code extension tell an engineer before the PR exists. Moving the same 35 detectors earlier is what turns a gate people work around into one they stop hitting.',
      },
      {
        title: 'Check our numbers before you trust them',
        body:
          'The detection engine is measured on 2,654 public queries — Spider, BIRD, and our own seeded and adversarial corpora — with the methodology fixed before the first query ran. The benchmark page publishes the detectors that scored badly alongside the ones that scored well, plus the two defects the benchmark itself found in our engine.',
        snippets: [
          {
            lang: 'bash',
            caption: 'Reproduce it yourself',
            code: `git clone https://github.com/mpingosystems/safesql
cd safesql && npm ci
python benchmark/run_benchmark.py --dataset seeded`,
          },
        ],
      },
    ],
    outcome:
      'A measurable baseline instead of an impression, one threshold the whole team shares, and the same deterministic check at the keyboard, the commit and the merge.',
  },
];

export function HowToPage() {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh' }}>
      <SiteNav current="how-to" />

      <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 32px 48px' }}>
        <h1 style={{ fontSize: 30, margin: '0 0 8px' }}>How to use SafeSQL Pro</h1>
        <p style={{ color: '#a1a1aa', fontSize: 15, lineHeight: 1.6, margin: '0 0 6px' }}>
          Five ways teams put deterministic SQL validation in front of production. Pick the one that
          matches your week — every command below is copy-pasteable as written.
        </p>
        <p style={{ color: '#71717a', fontSize: 13, lineHeight: 1.6, marginBottom: 26 }}>
          Same engine everywhere: 35 detectors, no ML in the detection layer, ~0.7 ms median. Results
          are measured on the{' '}
          <a href="#/benchmark" style={{ color: '#a78bfa' }}>
            public benchmark
          </a>
          .
        </p>

        <UseCaseTabs useCases={USE_CASES} defaultId={DEFAULT_TAB} />

        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            justifyContent: 'center',
            marginTop: 32,
            paddingTop: 22,
            borderTop: '1px solid #27272a',
          }}
        >
          <a
            href="#/editor"
            style={{
              background: '#7c3aed',
              color: 'white',
              textDecoration: 'none',
              padding: '11px 20px',
              borderRadius: 5,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Validate your SQL free →
          </a>
          <a
            href="#/benchmark"
            style={{
              background: 'transparent',
              color: '#e4e4e7',
              border: '1px solid #27272a',
              textDecoration: 'none',
              padding: '11px 20px',
              borderRadius: 5,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            See the benchmark
          </a>
        </div>
      </div>
    </div>
  );
}
