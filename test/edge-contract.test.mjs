import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const source = fs.readFileSync('src/index.ts', 'utf8');
const config = fs.readFileSync('wrangler.toml', 'utf8');

function loadWorker() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  return module.exports.default;
}

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
  const worker = loadWorker();
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

test('Edge transport forwards every shared JSON fixture byte-for-byte to canonical Vercel only', async () => {
  const worker = loadWorker();
  const originalFetch = globalThis.fetch;
  const OriginalRequest = globalThis.Request;
  const forwarded = [];
  const fixtureRoot = path.resolve('test/fixtures/dinodia-v1/fixtures');
  const fixtureFiles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) fixtureFiles.push(absolute);
    }
  };
  walk(fixtureRoot);
  assert.ok(fixtureFiles.length >= 80, `expected the complete shared fixture corpus, found ${fixtureFiles.length}`);
  const fixtureIndex = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'index.json'), 'utf8'));
  const indexedFiles = new Set(Object.values(fixtureIndex.screenFixtures).flat().map((ref) => path.resolve(path.dirname(fixtureRoot), ref)));
  assert.ok(indexedFiles.size >= 50, 'expected the complete indexed screen/action fixture set');
  assert.ok([...indexedFiles].every((file) => fixtureFiles.includes(file)), 'every indexed fixture must be exercised by the Edge transport');

  try {
    // Cloudflare Workers accepts a streaming Request body without Node/undici's
    // `duplex: "half"` extension. Adapt only the test runtime so the production
    // worker is exercised with Workers-compatible Request semantics.
    globalThis.Request = class WorkersCompatibleRequest extends OriginalRequest {
      constructor(input, init) {
        const adjusted = init?.body && init.duplex === undefined ? { ...init, duplex: 'half' } : init;
        super(input, adjusted);
      }
    };
    globalThis.fetch = async (request) => {
      const captured = new Request(request);
      forwarded.push({ url: captured.url, method: captured.method, body: await captured.text(), headers: captured.headers });
      return new Response(null, { status: 204, headers: { 'x-vercel-protection-bypass': 'must-not-return' } });
    };
    const env = {
      VERCEL_APP_ORIGIN: 'https://dinodia-platform-v2.vercel.app',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'test-only-not-a-real-secret',
    };
    for (const [index, fixtureFile] of fixtureFiles.entries()) {
      const bytes = fs.readFileSync(fixtureFile);
      const query = `?fixture=${index}`;
      const response = await worker.fetch(new Request(`https://edge.example/api/v2/contract-fixture${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.40' },
        body: bytes,
      }), env);
      assert.equal(response.status, 204, path.relative(fixtureRoot, fixtureFile));
      assert.equal(response.headers.get('x-vercel-protection-bypass'), null, 'the upstream bypass credential must be stripped from the response');
      assert.equal(response.headers.get('x-dinodia-api-backend'), 'vercel-v2');
      const observed = forwarded[index];
      assert.equal(observed.url, `https://dinodia-platform-v2.vercel.app/api/v2/contract-fixture${query}`);
      assert.equal(observed.method, 'POST');
      assert.deepEqual(Buffer.from(observed.body), bytes, `fixture bytes changed in Edge transport: ${path.relative(fixtureRoot, fixtureFile)}`);
      assert.equal(observed.headers.get('host'), 'edge.example');
      assert.equal(observed.headers.get('x-forwarded-host'), 'edge.example');
      assert.equal(observed.headers.get('x-forwarded-proto'), 'https');
      assert.equal(observed.headers.get('x-forwarded-for'), '192.0.2.40');
      assert.equal(observed.headers.get('x-vercel-protection-bypass'), 'test-only-not-a-real-secret');
    }
    assert.equal(forwarded.length, fixtureFiles.length, 'each fixture must make exactly one canonical upstream request');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Request = OriginalRequest;
  }
});

test('edge contract fixture copy matches dinodia.v1 and contains no protocol authority', () => {
  const root = 'test/fixtures/dinodia-v1';
  const manifest = JSON.parse(fs.readFileSync(`${root}/manifest.json`, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(`${root}/contract.json`, 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(`${root}/fixtures/multi-control-device.json`, 'utf8'));
  assert.equal(manifest.contractVersion, contract.contractVersion);
  assert.equal(contract.contractVersion, 'dinodia.v1');
  assert.equal(fixture.device.homeId, fixture.context.homeId);
  assert.equal('serviceId' in fixture.device, false);
  assert.equal('entity_id' in fixture.device, false);
  const decisions = JSON.parse(fs.readFileSync(`${root}/fixtures/stage2-decision-matrix.json`, 'utf8'));
  assert.equal(decisions.schemaVersion, contract.contractVersion);
  assert.equal(decisions.offline.scopeCanWiden, false);
  assert.equal(decisions.controls.securityControlAlexaExposed, false);
  assert.equal(decisions.identity.activeOwnerMembershipIds.length, 1);
  assert.ok(decisions.identity.activeManagerMembershipIds.length > 1);
  assert.equal(decisions.tenantPrivacy.managerCanRead, false);
  assert.equal(decisions.automation.staleRevisionIsRejectedWithoutMerge, true);
  assert.equal(decisions.automation.presentationLabelsGrantCapability, false);
  assert.equal(decisions.alexa.activeMembershipRole, 'TENANT');
  assert.equal(decisions.alexa.otherTenantDeviceEligible, false);
  assert.equal(decisions.trustedDevice.removalRevokesAccountInstallation, true);
  assert.equal(decisions.provisioning.manufacturingRootPrivateKeyOnHub, false);
  assert.equal(decisions.roomQr.installerSetupPresentationIsCustomerClaim, false);
  assert.deepEqual(decisions.support.categories, ['ACCOUNT_OR_SIGN_IN', 'ACCESS_OR_PERMISSIONS', 'DEVICE_PROBLEM', 'HUB_OR_CONNECTION', 'AUTOMATION', 'ALEXA', 'OTHER']);
  assert.equal(decisions.support.privateTenantDeviceTicketVisibleToOwner, false);
  assert.deepEqual(decisions.notifications.channels, ['push', 'verified_email']);
  assert.equal(decisions.notifications.deliveryReceiptGrantsAuthority, false);
});
