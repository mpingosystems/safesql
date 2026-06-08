# SafeSQL dbt Integration — Developer Notes

How to test `validate_dbt.py` locally without a full dbt project.

## Minimal fixture

```bash
mkdir -p sample/models
cat > sample/models/orders.sql <<'SQL'
SELECT u.country, SUM(o.total_amount) AS revenue
FROM {{ ref('users') }} u
JOIN {{ ref('orders') }} o ON o.user_id = u.id
JOIN {{ ref('user_tags') }} t ON t.user_id = u.id
GROUP BY u.country
SQL

cat > sample/models/schema.yml <<'YML'
models:
  - name: orders
    columns:
      - name: total_amount
        data_type: NUMERIC
      - name: user_id
        data_type: UUID
YML
```

## Run it

```bash
export SAFESQL_API_KEY=ssk_live_xxxx
python validate_dbt.py --project-dir sample --dialect postgresql
# → flags AGGREGATE_OVER_FANOUT_JOIN on orders.sql, exits 1
```

## Unit-testing the pure helpers (no network)

```python
from validate_dbt import strip_dbt_jinja
assert "__dbt_ref__" in strip_dbt_jinja("SELECT * FROM {{ ref('users') }}")
assert "{%" not in strip_dbt_jinja("{% if true %}SELECT 1{% endif %}")
```

## Pointing at a local API

```bash
export SAFESQL_API_URL=http://localhost:8788/api/validate   # wrangler pages dev
```

## Notes
- The script never duplicates validator logic — it only calls `/api/validate`.
- `extract_schema_from_dbt` is best-effort: it reads `columns[].data_type` from
  `schema.yml`/`sources.yml`. Models without typed columns are validated without
  a schema (structural detectors still fire; column-level ones are skipped).
