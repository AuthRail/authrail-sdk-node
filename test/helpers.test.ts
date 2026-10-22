import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { discover, extractContextFact, lookupCustomerFact,
  lookupQuickBooksInvoiceBalance, lookupStripeInvoiceStatus,
  newCustomerAPIReader } from '../src/index.js';

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
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('Stripe-Account'), accountId);
      if (String(url).endsWith('/account'))
        return new Response(JSON.stringify({ id: accountId, object: 'account' }));
      return new Response(JSON.stringify({ id: 'in_1234', object: 'invoice', status: 'paid' }));
    } }, 'in_1234');
  assert.equal(connected.value?.status, 'paid');
  const wrongConnectedAccount = await lookupStripeInvoiceStatus({ ...source,
    connectedAccount: true, fetch: async (url) => {
      assert.ok(String(url).endsWith('/account'));
      return new Response(JSON.stringify({ id: 'acct_987654321', object: 'account' }));
    } }, 'in_1234');
  assert.equal(wrongConnectedAccount.status, 'untrusted');
});

test('Stripe lookup stops after an expired account check even if the transport ignores abort', async () => {
  let invoiceRequests = 0;
  const result = await lookupStripeInvoiceStatus({ sourceVersionId,
    providerAccountId: 'acct_123456789', timeoutMs: 100, secretKey: 'sk_test_secret',
    fetch: async (url) => {
      if (String(url).endsWith('/account')) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return new Response(JSON.stringify({ id: 'acct_123456789', object: 'account' }));
      }
      invoiceRequests++;
      return new Response(JSON.stringify({ id: 'in_1234', object: 'invoice', status: 'paid' }));
    } }, 'in_1234');
  assert.equal(result.status, 'unavailable');
  assert.equal(invoiceRequests, 0);
});

test('QuickBooks lookup binds reviewed realm and invoice and returns the Rail value shape', async () => {
  const source = { sourceVersionId, providerAccountId: '1234567890',
    timeoutMs: 500, accessToken: 'protected-oauth', sandbox: true,
    fetch: async (url: URL | RequestInfo, init?: RequestInit) => {
      assert.equal(String(url),
        'https://sandbox-quickbooks.api.intuit.com/v3/company/1234567890/invoice/42');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer protected-oauth');
      return new Response(JSON.stringify({ Invoice: { Id: '42', Balance: 12.5 } }));
    } };
  const found = await lookupQuickBooksInvoiceBalance(source, '42');
  assert.equal(found.status, 'ok');
  assert.equal(found.providerAccountId, '1234567890');
  assert.equal(found.lookupKey, '42');
  assert.deepEqual(found.value, { Invoice: { Balance: 12.5 } });
  assert.ok(found.observedAt);

  const wrongInvoice = await lookupQuickBooksInvoiceBalance({ ...source,
    fetch: async () => new Response(JSON.stringify({ Invoice: { Id: '43', Balance: 0 } })) }, '42');
  assert.equal(wrongInvoice.status, 'untrusted');
  const malformed = await lookupQuickBooksInvoiceBalance({ ...source,
    fetch: async () => new Response('{invalid') }, '42');
  assert.equal(malformed.status, 'untrusted');
  const oversized = await lookupQuickBooksInvoiceBalance({ ...source,
    fetch: async () => new Response('x'.repeat(64 * 1024 + 1)) }, '42');
  assert.equal(oversized.status, 'unavailable');
  const redirect = await lookupQuickBooksInvoiceBalance({ ...source,
    fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere/' } }) }, '42');
  assert.equal(redirect.status, 'unavailable');
  const failed = await lookupQuickBooksInvoiceBalance({ ...source,
    fetch: async () => { throw new Error('network'); } }, '42');
  assert.equal(failed.status, 'unavailable');
  const production = await lookupQuickBooksInvoiceBalance({ ...source, sandbox: false,
    fetch: async (url) => {
      assert.equal(String(url), 'https://quickbooks.api.intuit.com/v3/company/1234567890/invoice/42');
      return new Response(JSON.stringify({ Invoice: { Id: '42', Balance: 0 } }));
    } }, '42');
  assert.equal(production.status, 'ok');
  await assert.rejects(lookupQuickBooksInvoiceBalance(source, '../other'));
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
