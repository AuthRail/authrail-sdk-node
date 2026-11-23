import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { lookupCustomerFact, extractContextFact, type CustomerReadResult, type ExtractionResult } from '../src/facts.js';

const source = {sourceVersionId: '00000000-0000-4000-8000-000000000008',sourceIdentity: 'customer_api',accountBoundary: 'tenant_123',lookup: 'invoice.read',timeoutMs: 100};
test('direct customer reader bounds waiting even when cancellation is ignored and discards late values', async () => {
  let release!: (value: CustomerReadResult) => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<CustomerReadResult>(resolve => {release = resolve;});
  const started = performance.now();
  try {
    const result = await Promise.race([lookupCustomerFact(source, 'invoice_123', async (_key, cancellation) => {signal = cancellation; return pending;}), delay(750).then(() => {throw new Error('Caller wait was not bounded');})]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.value, undefined);
    assert.equal(signal?.aborted, true); assert.ok(performance.now() - started < 700);
    release({...source,lookupKey: 'invoice_123',observedAt: new Date().toISOString(),value: {status: 'paid'}});
    await delay(0); assert.equal(result.value, undefined);
  } finally {release({...source,lookupKey: 'invoice_123',observedAt: new Date().toISOString(),value: {status: 'paid'}});}
});
test('direct extractor bounds waiting and consumes late callback rejection', async () => {
  const extraction = {...source,resultPath: ['sensitive'],valueType: 'boolean' as const,modelId: 'model-v1',modelConfigSha256: 'a'.repeat(64),promptVersion: 'prompt-v1',maxInputBytes: 100,maxOutputBytes: 100};
  let reject!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<ExtractionResult>((_resolve, failure) => {reject = failure;});
  try {
    const result = await Promise.race([extractContextFact(extraction, 'invoice_123', 'document:123', new Date().toISOString(), Buffer.from('private document'), async (_document, cancellation) => {signal = cancellation; return pending;}), delay(750).then(() => {throw new Error('Extractor wait was not bounded');})]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.extraction, undefined); assert.equal(signal?.aborted, true);
    reject(new Error('Late callback error')); await delay(0); assert.equal(result.value, undefined);
  } finally {reject(new Error('Callback released after verification'));}
});
