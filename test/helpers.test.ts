import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { discover, extractContextFact, lookupCustomerFact,
  lookupStripeInvoiceStatus, newCustomerAPIReader } from '../src/index.js';

const sourceVersionId = '11111111-1111-4111-8111-111111111111';

test('discovery binds setup key and validates the returned Inventory identity', async () => {
  const found = await discover({ controlPlaneUrl: 'https://authrail.example.com',
    setupKey: 'setup-secret', agentKey: 'support-agent',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://authrail.example.com/runtime/discovery');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer setup-secret');
      assert.deepEqual(JSON.parse(String(init?.body)), { agentKey: 'support-agent' });
      return new Response(JSON.stringify({ inventoryItemId: sourceVersionId,
        inventoryRevisionId: sourceVersionId, deploymentId: sourceVersionId,
        confirmationStatus: 'discovered' }), { status: 201 });
    } });
  assert.equal(found.confirmationStatus, 'discovered');
  await assert.rejects(discover({ controlPlaneUrl: 'http://elsewhere.example.com',
    setupKey: 'secret', agentKey: 'agent' }));
});

test('customer fact reader pins source, account and record', async () => {
  const source = { sourceVersionId, sourceIdentity: 'customer_api',
    accountBoundary: 'tenant_123', lookup: 'invoice.read', timeoutMs: 500 };
  const read = newCustomerAPIReader({ endpoint: 'https://customer.example.com/invoices',
    bearerToken: 'private', sourceIdentity: source.sourceIdentity,
    accountBoundary: source.accountBoundary, lookup: source.lookup,
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://customer.example.com/invoices/invoice_123');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private');
      return new Response(JSON.stringify({ accountId: 'tenant_123', recordId: 'invoice_123',
        observedAt: new Date().toISOString(), data: { status: 'open' } }));
    } });
  const ok = await lookupCustomerFact(source, 'invoice_123', read);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.value, { status: 'open' });
  const mismatched = await lookupCustomerFact(source, 'invoice_123', async () =>
    ({ sourceIdentity: 'customer_api', accountBoundary: 'other_tenant',
      lookup: 'invoice.read', lookupKey: 'invoice_123',
      observedAt: new Date().toISOString(), value: { status: 'paid' } }));
  assert.equal(mismatched.status, 'untrusted');
});

test('Stripe lookup checks account and invoice; connected account sends reviewed header', async () => {
  const accountId = 'acct_123456789';
  const requests: string[] = [];
  const source = { sourceVersionId, providerAccountId: accountId,
    timeoutMs: 500, secretKey: 'sk_test_secret', fetch: async (url: URL | RequestInfo,
      init?: RequestInit) => {
      requests.push(String(url));
      if (String(url).endsWith('/account'))
        return new Response(JSON.stringify({ id: accountId, object: 'account' }));
      assert.equal(new Headers(init?.headers).get('Stripe-Account'), null);
      return new Response(JSON.stringify({ id: 'in_1234', object: 'invoice', status: 'open' }));
    } };
  assert.equal((await lookupStripeInvoiceStatus(source, 'in_1234')).status, 'ok');
  assert.deepEqual(requests, ['https://api.stripe.com/v1/account',
    'https://api.stripe.com/v1/invoices/in_1234']);
  const connected = await lookupStripeInvoiceStatus({ ...source, connectedAccount: true,
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('Stripe-Account'), accountId);
      return new Response(JSON.stringify({ id: 'in_1234', object: 'invoice', status: 'paid' }));
    } }, 'in_1234');
  assert.equal(connected.value?.status, 'paid');
});

test('AI extraction binds reviewed model and returns only a bounded typed fact', async () => {
  const source = { sourceVersionId, sourceIdentity: 'invoice_document',
    accountBoundary: 'tenant_123', lookup: 'invoice.read', timeoutMs: 500,
    resultPath: ['invoice', 'risk'], valueType: 'string' as const,
    modelId: 'model-v1', modelConfigSha256: createHash('sha256').update('settings').digest('hex'),
    promptVersion: 'prompt-v1', maxInputBytes: 1024, maxOutputBytes: 128 };
  const document = Buffer.from('Invoice 123');
  const result = await extractContextFact(source, 'invoice_123', 'storage/document-123',
    new Date().toISOString(), document, async (received) => {
      assert.equal(Buffer.from(received).toString(), 'Invoice 123');
      return { value: 'low', uncertain: false, modelId: source.modelId,
        modelConfigSha256: source.modelConfigSha256, promptVersion: source.promptVersion };
    });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.value, { invoice: { risk: 'low' } });
  assert.equal(result.extraction?.sourceSha256,
    createHash('sha256').update(document).digest('hex'));
  const mismatch = await extractContextFact(source, 'invoice_123', 'storage/document-123',
    new Date().toISOString(), document, async () => ({ value: 'low', uncertain: false,
      modelId: 'other-model', modelConfigSha256: source.modelConfigSha256,
      promptVersion: source.promptVersion }));
  assert.equal(mismatch.status, 'untrusted');
});
