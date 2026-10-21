const reference = /^[A-Za-z0-9._:-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Discovery = {
  inventoryItemId: string;
  inventoryRevisionId: string;
  deploymentId: string;
  confirmationStatus: 'discovered' | 'confirmed';
};

/** Limits untrusted HTTP bodies before JSON parsing. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Response is too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A setup key resolves Inventory identity only; it cannot authorize an action. */
export async function discover(config: {
  controlPlaneUrl: string;
  setupKey: string;
  agentKey: string;
  fetch?: typeof globalThis.fetch;
}): Promise<Discovery> {
  let url: URL;
  try { url = new URL(config.controlPlaneUrl); }
  catch { throw new Error('Control plane URL is invalid'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname))) || !url.hostname ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !reference.test(config.agentKey) || !config.setupKey || /[\r\n]/.test(config.setupKey)) {
    throw new Error('Discovery configuration is invalid');
  }
  const response = await (config.fetch ?? fetch)(new URL('/runtime/discovery', url), {
    method: 'POST', redirect: 'manual',
    headers: { Authorization: `Bearer ${config.setupKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentKey: config.agentKey }), signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 201) throw new Error('AI system discovery was not accepted');
  const body = await readBoundedText(response, 8192);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error('Discovery response is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Discovery response is invalid');
  const value = parsed as Record<string, unknown>;
  if (!['inventoryItemId', 'inventoryRevisionId', 'deploymentId'].every(
      (key) => typeof value[key] === 'string' && uuid.test(value[key])) ||
    (value.confirmationStatus !== 'discovered' && value.confirmationStatus !== 'confirmed')) {
    throw new Error('Discovery response is invalid');
  }
  return value as Discovery;
}
