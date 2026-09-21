import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/index.ts', 'utf8');
const config = fs.readFileSync('wrangler.toml', 'utf8');

test('edge worker is Vercel-only and API-only', () => {
  assert.match(source, /dinodia-platform-v2/);
  assert.doesNotMatch(source, /AWS_ORIGIN|dinodia-platform-aws|homeassistant/i);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /status: 404/);
  assert.match(source, /x-vercel-protection-bypass/);
});

test('edge secret is not configured as plaintext', () => {
  assert.match(source, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.doesNotMatch(config, /VERCEL_AUTOMATION_BYPASS_SECRET\s*=/);
  assert.doesNotMatch(config, /x-vercel-protection-bypass\s*=/i);
});
