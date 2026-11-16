const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { fixture, transportFixture, deferred, flush } = require('./helpers.cjs');

function abortFailure() { const error = new Error('cancelled'); error.name = 'AbortError'; return error; }
const openai = { connectionSource: 'openai', openaiUrl: 'https://example.invalid/v1', openaiKey: 'DUMMY', openaiModel: 'dummy' };
const ollama = { connectionSource: 'ollama', ollamaUrl: 'http://localhost:11434', ollamaModel: 'dummy' };
function sseResponse(text) {
    return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
    } }) };
}

for (const [name, settings] of [['remote OpenAI', openai], ['local OpenAI', { ...openai, openaiUrl: 'http://localhost:1234/v1' }], ['Ollama', ollama]]) {
    test(`${name} cancels fetch without falling back or retrying`, async () => {
        const calls = [], controller = new AbortController();
        const api = transportFixture({ fetch(url, options) {
            calls.push({ url, options });
            return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(abortFailure()), { once: true }));
        } });
        const task = api.sendSummarizerRequest(settings, 'system', 'user', { signal: controller.signal });
        assert.equal(calls[0].options.signal, controller.signal);
        controller.abort();
        await assert.rejects(task, { name: 'AbortError' });
        assert.equal(calls.length, 1);
    });
}

test('OpenAI abort cancels a pending stream read and releases the reader', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const stream = new ReadableStream({ cancel() { cancelled++; } });
    const api = transportFixture({ fetch: async () => ({ ok: true, body: stream }) });
    const task = api.sendSummarizerRequest(openai, 'system', 'user', { signal: controller.signal });
    await flush();
    assert.equal(stream.locked, true);
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful OpenAI streams still return content and remove abort listeners', async () => {
    const controller = new AbortController();
    const response = sseResponse('a summary');
    const api = transportFixture({ fetch: async () => response });
    assert.equal(await api.sendSummarizerRequest(openai, 'system', 'user', { signal: controller.signal }), 'a summary');
    assert.equal(response.body.locked, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Ollama proxy network fallback reuses the same cancellation signal', async () => {
    const controller = new AbortController(), calls = [];
    const api = transportFixture({ fetch: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) throw new TypeError('fetch failed');
        return { ok: true, json: async () => ({ message: { content: 'summary' } }) };
    } });
    assert.equal(await api.sendSummarizerRequest(ollama, 'system', 'user', { signal: controller.signal }), 'summary');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.options.signal === controller.signal));
});

test('OpenAI proxy network fallback reuses the same cancellation signal', async () => {
    const controller = new AbortController(), calls = [];
    const api = transportFixture({ fetch: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) throw new TypeError('fetch failed');
        return sseResponse('summary');
    } });
    assert.equal(await api.sendSummarizerRequest({ ...openai, openaiUrl: 'http://localhost:1234' }, 'system', 'user', { signal: controller.signal }), 'summary');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.options.signal === controller.signal));
});

test('profile requests put cancellation in the ST fourth options argument', async () => {
    const controller = new AbortController();
    let captured;
    const api = transportFixture({ SillyTavern: { getContext: () => ({ ConnectionManagerRequestService: {
        sendRequest(...args) {
            captured = args;
            return new Promise((resolve, reject) => args[3].signal.addEventListener('abort', () => reject(abortFailure()), { once: true }));
        },
    } }) } });
    const task = api.sendSummarizerRequest({ connectionSource: 'profile', connectionProfileId: 'saved' }, 'system', 'user', { signal: controller.signal });
    assert.equal(captured[0], 'saved');
    assert.equal(captured[2], undefined);
    assert.equal(captured[3].signal, controller.signal);
    assert.equal(captured[3].includeInstruct, false);
    assert.deepEqual(Array.from(captured[1], item => item.role), ['system', 'user']);
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
});

test('profile responses still extract text with the corrected signature', async () => {
    const api = transportFixture({ SillyTavern: { getContext: () => ({ ConnectionManagerRequestService: {
        sendRequest: async () => ({ content: 'profile summary' }),
    } }) } });
    assert.equal(await api.sendSummarizerRequest({ connectionSource: 'profile', connectionProfileId: 'saved' }, 'system', 'user'), 'profile summary');
});

test('default requests invoke the host stop hook and clean up their listener', async () => {
    const controller = new AbortController(), request = deferred();
    let stopCalls = 0, captured;
    const api = transportFixture({ SillyTavern: { getContext: () => ({
        generateRaw: async options => { captured = options; return await request.promise; },
        stopGeneration() { stopCalls++; request.reject(new Error('host stopped')); },
    }) } });
    const task = api.sendSummarizerRequest({ connectionSource: 'default', summarizerResponseLength: 512 }, 'system', 'user', { signal: controller.signal });
    assert.equal(captured.prompt, 'user');
    assert.equal(captured.systemPrompt, 'system');
    assert.equal(captured.responseLength, 512);
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(stopCalls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('default successful requests remove their stop hook', async () => {
    const controller = new AbortController();
    let stopCalls = 0;
    const api = transportFixture({ SillyTavern: { getContext: () => ({
        generateRaw: async () => 'summary', stopGeneration() { stopCalls++; },
    }) } });
    assert.equal(await api.sendSummarizerRequest({ connectionSource: 'default' }, 'system', 'user', { signal: controller.signal }), 'summary');
    controller.abort();
    assert.equal(stopCalls, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pre-aborted requests never reach any backend', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = transportFixture({ fetch() { throw new Error('must not fetch'); }, SillyTavern: {
        getContext() { throw new Error('must not access backend'); },
    } });
    for (const settings of [openai, ollama, { connectionSource: 'default' }, { connectionSource: 'profile' }]) {
        await assert.rejects(api.sendSummarizerRequest(settings, 'system', 'user', { signal: controller.signal }), { name: 'AbortError' });
    }
});

test('end-to-end Stop aborts the real transport and prevents further catchup', async t => {
    const f = fixture(); t.after(() => f.close());
    const calls = [];
    const api = transportFixture({ SillyTavern: f.context, fetch(url, options) {
        calls.push(options);
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(abortFailure()), { once: true }));
    } });
    f.state.send = api.sendSummarizerRequest;
    f.run(`Object.assign(getSettings(), ${JSON.stringify(openai)})`);
    const task = f.run('runCatchup(getAssistantTurns(SillyTavern.getContext().chat), 2)');
    f.run('abortSummarization()');
    await task;
    await f.advance(1000000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(f.commands.length, 0);
    assert.equal(f.saves.length, 0);
});

test('default-mode cleanup restores only the original prompt entries', async t => {
    const f = fixture(); t.after(() => f.close());
    const entryA = { identifier: 'same-id', enabled: true };
    const entryB = { identifier: 'same-id', enabled: false };
    f.a.promptManager = { getPromptOrderEntries: () => [entryA] };
    f.b.promptManager = { getPromptOrderEntries: () => [entryB] };
    f.run('getSettings().connectionSource = "default"');
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    assert.equal(entryA.enabled, false);
    f.activate(f.b); f.run('onChatChanged()');
    await task;
    assert.equal(entryA.enabled, true);
    assert.equal(entryB.enabled, false);
});
