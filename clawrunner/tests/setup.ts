/**
 * Test setup for ClawRunner tests
 */

// Set up environment variables for testing
process.env.NANGO_SECRET_KEY = 'test-nango-secret-key';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

// Suppress console logs during tests unless VERBOSE is set
if (!process.env.VERBOSE) {
  console.log = () => {};
  console.error = () => {};
}
