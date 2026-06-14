-- This query is clean
-- SafeSQL Pro should pass it
SELECT u.email, COUNT(DISTINCT o.id) AS order_count
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.deleted_at IS NULL
GROUP BY u.email;
