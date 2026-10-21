import { createHash } from 'node:crypto';
import type { ExtractionSource, Extractor, ExtractionResult } from './facts.js';

export type DecisionsQuestion =
  | { type: 'predicate'; instructions: string; minConfidence: number }
  | { type: 'choice'; instructions: string; choices: string[]; minConfidence: number }
  | { type: 'score'; instructions: string; levels: string[]; minConfidence: number };

const model = 'gpt-6-luna';
const endpoint = 'https://api.openai.com/v1/decisions';
const maxResponseBytes = 16 * 1024;

function validQuestion(question: DecisionsQuestion): boolean {
  if (!['predicate', 'choice', 'score'].includes(question.type) ||
    !question.instructions.trim() || Buffer.byteLength(question.instructions) > 2048 ||
    !Number.isFinite(question.minConfidence) || question.minConfidence < 0.5 ||
    question.minConfidence > 1) return false;
  if (question.type === 'predicate') return true;
  const entries = question.type === 'choice' ? question.choices : question.levels;
  return entries.length >= 2 && entries.length <= 16 &&
    entries.every((entry) => typeof entry === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(entry)) &&
    new Set(entries).size === entries.length;
}

function questionConfig(question: DecisionsQuestion) {
  return question.type === 'predicate'
    ? { model, type: question.type, instructions: question.instructions,
      minConfidence: question.minConfidence }
    : { model, type: question.type, instructions: question.instructions,
      entries: question.type === 'choice' ? question.choices : question.levels,
      minConfidence: question.minConfidence };
}

/** Pin this digest in the reviewed source; changing instructions or thresholds requires a new source version. */
export function openAIDecisionsConfigSha256(question: DecisionsQuestion): string {
  if (!validQuestion(question)) throw new Error('Contextual question configuration is invalid');
  return createHash('sha256').update(JSON.stringify(questionConfig(question))).digest('hex');
}

/** Creates a protected-executor extractor. Document bytes go only to the configured OpenAI endpoint. */
export function newOpenAIDecisionsExtractor(config: {
  source: ExtractionSource; question: DecisionsQuestion; apiKey: string;
  fetch?: typeof globalThis.fetch;
}): Extractor {
  const { source, question } = config;
  if (source.modelId !== model || source.modelConfigSha256 !== openAIDecisionsConfigSha256(question) ||
    !source.promptVersion || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) ||
    !Number.isInteger(source.maxInputBytes) || source.maxInputBytes < 1 || source.maxInputBytes > 65536 ||
    !Number.isInteger(source.maxOutputBytes) || source.maxOutputBytes < 1 || source.maxOutputBytes > 4096 ||
    !Number.isInteger(source.timeoutMs) || source.timeoutMs < 100 || source.timeoutMs > 10000 ||
    (question.type === 'predicate' && source.valueType !== 'boolean') ||
    (question.type === 'choice' && source.valueType !== 'string') ||
    (question.type === 'score' && source.valueType !== 'number')) {
    throw new Error('Contextual extractor configuration is invalid');
  }
  const apiKey = config.apiKey;
  const request = config.fetch ?? fetch;
  const apiQuestion = question.type === 'predicate'
    ? { type: 'predicate', name: 'fact', instructions: question.instructions }
    : question.type === 'choice'
      ? { type: 'choice', name: 'fact', instructions: question.instructions,
        choices: question.choices.map((value) => ({ value })) }
      : { type: 'score', name: 'fact', instructions: question.instructions,
        levels: question.levels.map((label) => ({ label })) };
  return async (document, signal): Promise<ExtractionResult> => {
    if (!document.byteLength || document.byteLength > source.maxInputBytes) throw new Error('Contextual source unavailable');
    let input: string;
    try { input = new TextDecoder('utf-8', { fatal: true }).decode(document); }
    catch { throw new Error('Contextual source unavailable'); }
    try {
      const response = await request(endpoint, { method: 'POST', redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(source.timeoutMs)]),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input, questions: [apiQuestion] }) });
      if (response.status !== 200) throw new Error('Contextual provider unavailable');
      const body = await readBounded(response, maxResponseBytes);
      const decoded = JSON.parse(body) as unknown;
      const result = parseAnswer(decoded, question);
      return { ...result, modelId: model, modelConfigSha256: source.modelConfigSha256,
        promptVersion: source.promptVersion };
    } catch {
      // Do not expose provider bodies, network details, or customer content to callers.
      throw new Error('Contextual provider unavailable');
    }
  };
}

function parseAnswer(input: unknown, question: DecisionsQuestion): Pick<ExtractionResult, 'value' | 'uncertain'> {
  if (!record(input) || input.model !== model || !Array.isArray(input.answers) ||
    input.answers.length !== 1 || !record(input.answers[0]))
    throw new Error('Contextual provider unavailable');
  const answer = input.answers[0];
  if (answer.name !== 'fact') throw new Error('Contextual provider unavailable');
  if (answer.type === 'refusal') return { value: null, uncertain: true };
  if (answer.type !== question.type) throw new Error('Contextual provider unavailable');
  if (question.type === 'predicate') {
    if (!probability(answer.probability)) throw new Error('Contextual provider unavailable');
    if (answer.probability >= question.minConfidence) return { value: true, uncertain: false };
    if (answer.probability <= 1 - question.minConfidence) return { value: false, uncertain: false };
    return { value: null, uncertain: true };
  }
  if (!probability(answer.confidence)) throw new Error('Contextual provider unavailable');
  if (question.type === 'choice') {
    if (typeof answer.choice !== 'string' || !question.choices.includes(answer.choice))
      throw new Error('Contextual provider unavailable');
    return { value: answer.confidence >= question.minConfidence ? answer.choice : null,
      uncertain: answer.confidence < question.minConfidence };
  }
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) ||
    answer.score < 0 || answer.score > question.levels.length - 1)
    throw new Error('Contextual provider unavailable');
  return { value: answer.confidence >= question.minConfidence ? answer.score : null,
    uncertain: answer.confidence < question.minConfidence };
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('Contextual provider unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Contextual provider unavailable');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
