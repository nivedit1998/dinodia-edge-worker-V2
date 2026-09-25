import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

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

test('worker forwards only the canonical stable Vercel origin', async () => {
  const source = fs.readFileSync('src/index.ts', 'utf8');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  const worker = module.exports.default;
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = async (request) => { forwarded.push(new Request(request)); return new Response('ok', { status: 200 }); };
  try {
    const env = { VERCEL_APP_ORIGIN: 'https://dinodia-platform-v2.vercel.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'test-only' };
    const response = await worker.fetch(new Request('https://edge.example/api/health?check=1'), env);
    assert.equal(response.status, 200);
    assert.equal(forwarded[0].url, 'https://dinodia-platform-v2.vercel.app/api/health?check=1');
    assert.equal(response.headers.get('x-dinodia-api-backend'), 'vercel-v2');
    for (const origin of ['https://dinodia-platform-v2-br7u28kh8-dinodia-supabase.vercel.app', 'https://app.dinodiasmartliving.com', 'https://example.invalid']) {
      const rejected = await worker.fetch(new Request('https://edge.example/api/health'), { ...env, VERCEL_APP_ORIGIN: origin });
      assert.equal(rejected.status, 503, origin);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
