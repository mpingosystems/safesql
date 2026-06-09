# The $50,000 JOIN: How a syntactically valid query broke our revenue for 6 months

It ran in 40 milliseconds. It passed code review. It returned rows. It was completely wrong, and it cost us about $50,000 in misallocated spend before anyone noticed.

This is a post-mortem of the most common and most expensive class of SQL bug in analytics engineering — the JOIN that silently multiplies your numbers. Names and figures are changed, but if you have written analytics SQL for more than a year, you have shipped a version of this query.

## The setup

We were a B2B SaaS company. Revenue lived in `orders`. Each customer could have many orders, and each customer could be tagged with many marketing attributes in `user_tags` (channel, campaign, segment). Marketing wanted revenue broken down by country, joined to those tags so they could slice spend.

The analyst wrote the obvious query:

```sql
SELECT u.country, SUM(o.total_amount) AS revenue
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN user_tags t ON t.user_id = u.id
GROUP BY u.country;
```

It looks right. It reads like English. "Give me revenue by country, with orders and tags joined in." Every reviewer nodded.

## What the database actually did

Here is the part nobody pictures when they read that query. The database does not join `orders` and `user_tags` to each other — it joins both to `users`, independently. So for a single user with **4 orders** and **3 tags**, the intermediate result is not 4 rows, and not 3 rows. It is **4 × 3 = 12 rows**.

Each order row is duplicated once for every tag. Then `SUM(o.total_amount)` faithfully adds up all 12 of those duplicated order amounts. The revenue for that user is inflated 3×.

This is called **fan-out** (or a "cartesian explosion along the join keys"). The inflation factor is not constant — it is the average number of tags per user, which drifted up over time as marketing added more tags. The revenue number got *more* wrong every month.

## Why the BI tool didn't catch it

This is the dangerous part. The query is valid SQL. It executes without error. It returns a clean result set with sensible-looking numbers. The BI dashboard rendered a bar chart. The numbers were plausible — revenue was "up." Nobody had a reason to suspect a 3× multiplier, because there was no error, no warning, no NULL, nothing.

Bad SQL that crashes is found in seconds. Bad SQL that returns *believable wrong numbers* lives in dashboards for months. Ours lived for six.

## How SafeSQL Pro would have caught it

This is exactly the pattern SafeSQL Pro's `AGGREGATE_OVER_FANOUT_JOIN` detector exists for. It parses the query into an AST, sees that both `orders` and `user_tags` join to `users` on the same key, and sees a `SUM` over a column from one of those child tables. It fires — before execution:

> **AGGREGATE_OVER_FANOUT_JOIN** — Joining `user_tags` alongside `orders` duplicates each `orders` row once per matching `user_tags` row, so `SUM(o.total_amount)` is multiplied. Pre-aggregate orders before joining.

No execution required. No synthetic guess. It is a fact about the shape of the query.

## The fix

Pre-aggregate each child table to its own grain *before* joining, so the join is 1:1:

```sql
WITH order_totals AS (
  SELECT user_id, SUM(total_amount) AS revenue
  FROM orders
  GROUP BY user_id
)
SELECT u.country, SUM(ot.revenue) AS revenue
FROM users u
JOIN order_totals ot ON ot.user_id = u.id
LEFT JOIN user_tags t ON t.user_id = u.id
GROUP BY u.country;
```

Now `order_totals` has exactly one row per user. Joining tags can still fan out the *rows*, but the revenue was already summed at the right grain, so the total is correct.

## What to check in your own queries

Run through this list the next time you write an aggregate over a join:

- **Count your one-to-many joins.** If two or more child tables join to the same parent and you aggregate a measure, you have a fan-out.
- **Watch `SUM` and `COUNT` after a JOIN.** They are the detonators. A measure summed over a multiplied row set is inflated.
- **Pre-aggregate to the measure's grain in a CTE** before joining anything that is not 1:1.
- **Sanity-check row counts.** If `SELECT COUNT(*)` after your joins is wildly larger than the number of parent rows, you have a multiplier.
- **Validate before you trust the number** — not after a VP catches it in a board meeting.

The query that broke our revenue was not exotic. It was the most natural way to express the request. That is precisely why this bug is everywhere: the correct query is *less* intuitive than the wrong one. A pre-execution validator that knows the shapes is the cheapest insurance you will ever buy.
