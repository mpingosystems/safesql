-- This query has a JOIN multiplication error
-- SafeSQL Pro should catch it and fail the CI check
SELECT u.country, SUM(o.total_amount) AS revenue
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN users u2 ON u2.id = u.id
GROUP BY u.country;
