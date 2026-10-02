/** Matches the `db-test` service in docker-compose.yml; CI overrides via TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://ggi:ggi_test_password@localhost:5441/ggi_test?schema=public';
