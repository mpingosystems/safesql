# AI writes SQL 4× faster. It's also wrong 25% of the time.

If you have wired Cursor or Copilot into your analytics workflow, you have felt the speed. You describe a metric in English, you get SQL back, it runs. The productivity jump is real.

The accuracy jump is not.

## The benchmark nobody puts on the slide

The **BIRD benchmark** (2025) measures how often a model's generated SQL produces the *correct result* on real databases. Best-in-class LLMs land around **75% execution accuracy**. Read that the other way: roughly **1 in 4** AI-generated analytical queries returns the wrong answer.

And here is the trap that makes it worse than a coin flip: the wrong 25% usually *runs*. It does not throw a syntax error. It returns rows. It looks done.

Follow-up research (ErrorLLM, arXiv 2026) found that LLM self-correction barely helps here, because self-debugging is triggered by *execution errors* — and these queries do not produce execution errors. There is no exception for the model to react to. The query "succeeds." The number is just wrong.

So the analyst, who is now moving 4× faster and trusts the tool, ships it.

## The three mistakes AI makes most

### 1. Hallucinated columns

The model invents a column that sounds like it should exist:

```sql
SELECT id, lifetime_value FROM users;
```

There is no `lifetime_value` on `users`. Against a real warehouse this errors — but in a templated pipeline, or against a permissive view, a hallucinated column is the single most common AI-SQL failure. A schema-aware validator catches it instantly: *Column `lifetime_value` does not exist on `users`.*

### 2. The LEFT JOIN that silently becomes an INNER JOIN

This one is subtle enough that experienced humans ship it too:

```sql
SELECT u.id, COUNT(o.id) AS completed_orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.status = 'completed'
GROUP BY u.id;
```

The intent is "all users, with their completed-order count (zero if none)." But the `WHERE o.status = 'completed'` filters on the nullable side of the LEFT JOIN. Users with no orders have `o.status = NULL`, the predicate drops them, and the LEFT JOIN silently collapses into an INNER JOIN. Every zero-order user vanishes from the report. The fix is to move the condition into the `ON` clause.

### 3. Missing time filters on revenue

```sql
SELECT SUM(total_amount) AS revenue
FROM orders
WHERE status = 'completed';
```

Asked for "this month's revenue," the model writes all-time revenue. It runs, it returns a big number, and it is presented as a monthly figure. Nothing is technically broken — it just answers a different question than the one asked.

## Why "it ran without errors" is the dangerous signal

Traditional tooling is built around execution. Syntax linters catch malformed SQL. dbt tests catch bad *output*, after the model runs. Observability tools catch anomalies, after they reach production. Every one of these triggers on something going visibly wrong.

AI-generated SQL fails *silently*. It runs, returns rows, and produces a plausible number. The exact signal everyone trusts — "no error" — is the signal that hides the bug.

## SafeSQL is the validation layer under your AI

SafeSQL is deterministic, pre-execution validation. It parses the query into an AST and runs 33 rule-based detectors — fan-out joins, hallucinated columns, LEFT-JOIN-in-WHERE, missing time filters, integer division, and more. The detection layer never guesses and never hallucinates: a rule either fires or it does not. AI is used only to *explain* findings in plain English, never to decide them.

That makes it the natural safety net under Cursor and Copilot: the AI writes the SQL 4× faster, and SafeSQL confirms it is actually correct before it runs.

## Add it to your workflow in one line

Validate a file from your terminal before you commit:

```sql
npx safesql validate query.sql --schema schema.sql --dialect postgresql
```

Or drop the GitHub Action into CI so no unsafe SQL reaches `main`. Either way, you keep the 4× speed — and you stop shipping the 25%.
