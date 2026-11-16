const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, flush } = require('./helpers.cjs');

function memory(overrides = {}) {
    return { layers: [[{ text: 'original memory', turnRange: [0, 1], timestamp: 1 }]],
        summarizedUpTo: 1, ghostedIndices: [0, 1], ...overrides };
}
function withFixture(t) { const f = fixture(); t.after(() => f.close()); return f; }
function tag(message, owned = true) {
    message.extra = { sc_ghosted: true, sc_hide_owned: owned };
    message.is_system = owned;
}

for (const [name, payload] of [
    ['script in turnRange', memory({ layers: [[{ text: 'safe', turnRange: ['<script>window.__audit = 1</script>', 1] }]] })],
    ['script in mergedCount', memory({ layers: [[{ text: 'safe', mergedCount: '<script>window.__audit = 1</script>', fromLayer: 0 }]] })],
    ['script in fromLayer', memory({ layers: [[{ text: 'safe', mergedCount: 3, fromLayer: '<script>window.__audit = 1</script>' }]] })],
    ['non-array layer', memory({ layers: [{}] })],
    ['null snippet', memory({ layers: [[null]] })],
    ['non-string text', memory({ layers: [[{ text: {} }]] })],
    ['reversed range', memory({ layers: [[{ text: 'safe', turnRange: [2, 1] }]] })],
    ['range outside chat', memory({ layers: [[{ text: 'safe', turnRange: [0, 999] }]] })],
    ['non-integer boundary', memory({ summarizedUpTo: '1' })],
    ['unbounded boundary', memory({ summarizedUpTo: 1e100 })],
    ['invalid hidden index', memory({ ghostedIndices: ['0 | /echo audit'] })],
]) {
    test(`rejects ${name} before changing memory or visibility`, async t => {
        const f = withFixture(t);
        const original = f.scope().store;
        original.layers = [[{ text: 'keep this' }]];
        tag(f.a.chat[0]);
        original.ghostedIndices = [0];
        const before = JSON.stringify(original);
        await f.import(payload);
        assert.equal(JSON.stringify(original), before);
        assert.equal(f.a.chat[0].extra.sc_ghosted, true);
        assert.equal(f.commands.length, 0);
        assert.equal(f.saves.length, 0);
        assert.equal(f.dom.window.__audit, undefined);
    });
}

test('loaded legacy chat metadata also renders as text', t => {
    const f = withFixture(t), scope = f.scope();
    const script = '<script>window.__audit = 1</script>';
    scope.store.layers = [[
        { text: script, turnRange: [script, 1] },
        { text: 'safe', mergedCount: script, fromLayer: script },
    ]];
    f.run('updateUI()');
    assert.equal(f.dom.window.__audit, undefined);
    assert.equal(f.$('#sc_snippet_browser script').length, 0);
    assert.ok(f.$('.sc-snippet-meta').text().includes(script));
});

test('valid import rebuilds ownership and preserves a manual hidden message', async t => {
    const f = withFixture(t);
    f.a.chat[1].is_system = true;
    await f.import(memory({ summarizedUpTo: 2, ghostedIndices: [1], layers: [[{ text: '<b>plain text</b>', turnRange: [0, 2] }]] }));
    assert.equal(f.store().layers[0][0].text, '<b>plain text</b>');
    assert.deepEqual(Array.from(f.store().ghostedIndices), [0, 2]);
    assert.equal(f.a.chat[1].extra?.sc_ghosted, undefined);
    assert.deepEqual(f.commands.map(entry => entry.command), ['/hide 0-0', '/hide 2-2']);
    assert.equal(f.$('.sc-snippet-text b').length, 0);
});

test('file reading stays bound to the chat where import was opened', async t => {
    const f = withFixture(t), scope = f.scope(), file = deferred();
    const task = f.run('importMemoryFile')({ size: 100, text: () => file.promise }, scope);
    f.activate(f.b);
    file.resolve(JSON.stringify(memory()));
    assert.equal(await task, false);
    assert.equal(f.commands.length, 0);
    assert.equal(f.saves.length, 0);
    assert.equal(f.b.chatMetadata.summaryception, undefined);
});

test('oversize imports are rejected without reading the file', async t => {
    const f = withFixture(t);
    const task = f.run('importMemoryFile')({ size: 26 * 1024 * 1024, text() { throw new Error('must not read'); } }, f.scope());
    assert.equal(await task, false);
    assert.equal(f.commands.length, 0);
});

test('late summary after a chat switch changes neither chat', async t => {
    const f = withFixture(t), scope = f.scope();
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    assert.equal(f.requests.length, 1);
    const signal = f.requests[0].args[3].signal;
    f.activate(f.b);
    f.run('onChatChanged()');
    assert.equal(signal.aborted, true);
    f.requests[0].resolve('late summary from A');
    assert.equal(await task, false);
    assert.equal(scope.store.layers.length, 0);
    assert.equal(f.b.chatMetadata.summaryception.layers.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.saves.length, 0);
});

test('identity guards work before CHAT_CHANGED and with a reused chat array', async t => {
    const f = withFixture(t), scope = f.scope();
    const oldMessages = [...f.a.chat];
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    const shared = f.a.chat;
    shared.splice(0, shared.length, ...f.b.chat);
    f.b.chat = shared;
    f.activate(f.b);
    f.requests[0].resolve('stale');
    assert.equal(await task, false);
    assert.equal(scope.store.layers.length, 0);
    assert.ok(oldMessages.every(message => !message.extra?.sc_ghosted));
    assert.ok(f.b.chat.every(message => !message.extra?.sc_ghosted));
    assert.equal(f.commands.length, 0);
    assert.equal(f.saves.length, 0);
});

test('switching away and back invalidates the original operation', async t => {
    const f = withFixture(t);
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    f.activate(f.b); f.run('onChatChanged()');
    f.activate(f.a); f.run('onChatChanged()');
    f.requests[0].resolve('late');
    assert.equal(await task, false);
    assert.equal(f.store().layers.length, 0);
    assert.equal(f.commands.length, 0);
});

test('editing source messages during generation discards the stale summary', async t => {
    const f = withFixture(t);
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    f.a.chat[1].mes = 'edited response';
    f.requests[0].resolve('obsolete summary');
    assert.equal(await task, false);
    assert.equal(f.store().layers.length, 0);
    assert.equal(f.commands.length, 0);
});

test('Stop ends catchup and holds the lock through cleanup', async t => {
    const f = withFixture(t);
    const task = f.run('runCatchup(getAssistantTurns(SillyTavern.getContext().chat), 2)');
    const signal = f.requests[0].args[3].signal;
    f.run('abortSummarization()');
    assert.equal(signal.aborted, true);
    assert.equal(f.run('activeOperation !== null'), true);
    assert.equal(f.run('beginChatOperation()'), null);
    await task;
    f.requests[0].resolve('ignored response');
    await f.advance(1000000);
    assert.equal(f.requests.length, 1);
    assert.equal(f.store().layers.length, 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.run('activeOperation'), null);
    assert.equal(f.timers.size, 0);
});

test('Stop during the inter-batch delay does not start another request', async t => {
    const f = withFixture(t);
    f.state.send = async () => 'summary';
    const task = f.run('runCatchup(getAssistantTurns(SillyTavern.getContext().chat), 2)');
    await flush();
    assert.equal(f.store().layers[0].length, 1);
    f.run('abortSummarization()');
    await task;
    await f.advance(1000000);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 0);
});

test('Stop during retry backoff clears the wait and does not retry', async t => {
    const f = withFixture(t);
    f.state.send = async () => { throw new Error('network unavailable'); };
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    await flush();
    assert.equal(f.requests.length, 1);
    f.run('abortSummarization()');
    assert.equal(await task, false);
    await f.advance(1000000);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 0);
});

test('request timeout aborts the attempt before retrying', async t => {
    const f = withFixture(t);
    const task = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    const signal = f.requests[0].args[3].signal;
    await f.advance(120000);
    assert.equal(signal.aborted, true);
    assert.equal(f.requests.length, 1);
    await f.advance(4000);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].args[3].signal.aborted, false);
    f.run('abortSummarization()');
    assert.equal(await task, false);
    assert.equal(f.timers.size, 0);
});

test('normal catchup still processes all eligible batches', async t => {
    const f = withFixture(t);
    f.state.send = async () => 'summary';
    const task = f.run('runCatchup(getAssistantTurns(SillyTavern.getContext().chat), 2)');
    await flush();
    await f.advance(400);
    await task;
    assert.equal(f.requests.length, 2);
    assert.equal(f.store().layers[0].length, 2);
    assert.equal(f.store().summarizedUpTo, 3);
    assert.deepEqual(f.commands.map(entry => entry.command), ['/hide 0-1', '/hide 2-3']);
    assert.equal(f.timers.size, 0);
    assert.equal(f.run('activeOperation'), null);
});

test('clearing cancels a pending summary before clearing memory', async t => {
    const f = withFixture(t), scope = f.scope();
    const summary = f.run('summarizeOneBatch(getAssistantTurns(SillyTavern.getContext().chat))');
    const cleared = f.run('clearChatMemory')(scope);
    assert.equal(await cleared, true);
    assert.equal(await summary, false);
    f.requests[0].resolve('cannot resurrect memory');
    await flush();
    assert.equal(scope.store.layers.length, 0);
    assert.equal(f.commands.length, 0);
    assert.deepEqual(f.saves, ['A']);
});

test('unhide only restores owned indices and preserves manual gaps', async t => {
    const f = withFixture(t), scope = f.scope();
    tag(f.a.chat[0]); tag(f.a.chat[2]);
    f.a.chat[1].is_system = true;
    scope.store.ghostedIndices = [0, 1, 2, 99];
    await f.run('unghostAllMessages')(scope);
    assert.equal(f.a.chat[1].is_system, true);
    assert.deepEqual(f.commands.map(entry => entry.command), ['/unhide 0-0', '/unhide 2-2']);
    assert.deepEqual(Array.from(scope.store.ghostedIndices), []);
});

test('messages summarized without hiding retain a later manual hide', async t => {
    const f = withFixture(t), scope = f.scope();
    tag(f.a.chat[0], false);
    f.a.chat[0].is_system = true;
    await f.run('unghostAllMessages')(scope);
    assert.equal(f.a.chat[0].is_system, true);
    assert.equal(f.a.chat[0].extra.sc_ghosted, undefined);
    assert.equal(f.commands.length, 0);
});

test('legacy ghost flags are restored, while cached indices alone are ignored', async t => {
    const f = withFixture(t), scope = f.scope();
    f.a.chat[0].extra = { sc_ghosted: true };
    f.a.chat[0].is_system = true;
    f.a.chat[2].is_system = true;
    scope.store.ghostedIndices = [2];
    await f.run('unghostAllMessages')(scope);
    assert.equal(f.a.chat[0].is_system, false);
    assert.equal(f.a.chat[2].is_system, true);
    assert.deepEqual(f.commands.map(entry => entry.command), ['/unhide 0-0']);
});

test('clear stops between unhide ranges when the chat changes', async t => {
    const f = withFixture(t), scope = f.scope(), command = deferred();
    scope.store.layers = [[{ text: 'must remain' }]];
    tag(f.a.chat[0]); tag(f.a.chat[2]);
    f.state.command = () => command.promise;
    const task = f.run('clearChatMemory')(scope);
    assert.equal(f.commands.length, 1);
    f.activate(f.b);
    command.resolve();
    assert.equal(await task, false);
    assert.equal(scope.store.layers[0][0].text, 'must remain');
    assert.equal(f.commands.length, 1);
    assert.equal(f.saves.length, 0);
    assert.equal(f.b.chatMetadata.summaryception, undefined);
});

test('a failed unhide does not clear memory or lose ownership', async t => {
    const f = withFixture(t), scope = f.scope();
    scope.store.layers = [[{ text: 'keep' }]];
    tag(f.a.chat[0]);
    f.state.command = async () => { throw new Error('host unavailable'); };
    assert.equal(await f.run('clearChatMemory')(scope), false);
    assert.equal(scope.store.layers[0][0].text, 'keep');
    assert.equal(f.a.chat[0].extra.sc_ghosted, true);
    assert.equal(f.saves.length, 0);
});

test('regeneration is discarded after switching chat or editing its source', async t => {
    const f = withFixture(t), scope = f.scope();
    scope.store.layers = [[{ text: 'original', turnRange: [0, 1] }]];
    const task = f.run('regenerateSnippet')(scope, 0, 0);
    f.activate(f.b); f.run('onChatChanged()');
    f.requests[0].resolve('late');
    assert.equal(await task, false);
    assert.equal(scope.store.layers[0][0].text, 'original');
    assert.equal(f.saves.length, 0);
});

test('promotion keeps source snippets until a valid result commits', async t => {
    const f = withFixture(t), scope = f.scope();
    f.run('getSettings().snippetsPerLayer = 1');
    scope.store.layers = [[{ text: 'one' }, { text: 'two' }], [{ text: 'seed' }]];
    const operation = f.run('beginChatOperation()');
    const task = f.run('maybePromoteLayer')(0, operation);
    assert.equal(scope.store.layers[0].length, 2);
    operation.controller.abort();
    await task;
    f.run('finishChatOperation')(operation);
    assert.equal(scope.store.layers[0].length, 2);
    assert.equal(scope.store.layers[1].length, 1);
});

test('queued message events cannot summarize a newly opened chat', async t => {
    const f = withFixture(t);
    f.run('onMessageReceived(1)');
    f.activate(f.b);
    await f.advance(500);
    assert.equal(f.requests.length, 0);
    assert.equal(f.commands.length, 0);
});

test('switching chat cancels an open backlog dialog and releases its lock', async t => {
    const f = withFixture(t);
    f.run('getSettings().verbatimTurns = 0');
    const task = f.run('maybeSummarizeTurns()');
    assert.equal(f.$('.sc-catchup-overlay').length, 1);
    f.activate(f.b); f.run('onChatChanged()');
    await task;
    assert.equal(f.$('.sc-catchup-overlay').length, 0);
    assert.equal(f.run('activeOperation'), null);
    assert.equal(f.requests.length, 0);
});

test('opening an empty-memory chat clears the previous injected summary', async t => {
    const f = withFixture(t);
    f.scope().store.layers = [[{ text: 'only A should see this' }]];
    f.run('updateInjection()');
    assert.ok(f.injections[0].text.includes('only A'));
    f.activate(f.b); f.run('onChatChanged(); onGenerationStarted()');
    assert.equal(f.injections.at(-1).chat, 'B');
    assert.equal(f.injections.at(-1).text, '');
});

test('repair ignores manually hidden messages without extension ownership', async t => {
    const f = withFixture(t);
    f.a.chat[1].is_system = true;
    f.a.chat[2].extra = { sc_hide_owned: true };
    f.a.chat[2].is_system = true;
    f.run('bindUIEvents()');
    await f.click('#sc_repair');
    assert.equal(f.a.chat[1].is_system, true);
    assert.deepEqual(f.commands.map(entry => entry.command), ['/unhide 2-2']);
});
