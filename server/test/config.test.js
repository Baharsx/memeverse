import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../config.js';

test('production requires managed PostgreSQL and disables manual agent evidence', () => {
  assert.throws(
    () => loadServerConfig({ NODE_ENV: 'production' }),
    /DATABASE_URL is required/,
  );
  const config = loadServerConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://memeverse:secret@db.example.test:5432/memeverse',
    AGENT_ALLOW_MANUAL_DEMO: 'true',
  });
  assert.equal(config.agentAllowManualDemo, false);
  assert.equal(config.runDatabaseMigrations, false);
  assert.equal(config.databaseUrl.startsWith('postgresql://'), true);
});
