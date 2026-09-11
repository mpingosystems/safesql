# dbt artifact fixture (Sprint 8)

Hand-trimmed dbt 1.8 artifacts (manifest v12, catalog v1, run-results v6) for a
tiny `shop` project. Keys not read by `dbtArtifacts.ts` are kept minimal but
shaped like the real thing so the parser is exercised on realistic input.
Regenerate with the script recorded in the Sprint 8 session if the shape needs
to change; edit by hand for small tweaks.

```
source raw.orders ──► stg_orders (view) ──┐
                                          ├─► int_orders_enriched (ephemeral) ──► fct_revenue (table, tag: finance)
source raw.customers ──► dim_customers ───┘
```

- `stg_orders.order_id` — `unique` + `not_null` → PK
- `stg_orders.customer_id` — `relationships` → `dim_customers.customer_id`, **no** `not_null` → nullable FK
- `dim_customers.customer_id` — `unique` + `not_null` → PK
- `fct_revenue.revenue` — manifest `data_type: number`, catalog `numeric(12,2)` → catalog wins
- `stg_orders.order_status` — present in the catalog only (never documented in schema.yml)
- `run_results`: `fct_revenue` = **error**, others success, the ephemeral model has no result
- `dim_customers` catalog `row_count` 4,820; `fct_revenue` 1,284,403
