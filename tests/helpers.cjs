const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const jquery = require('jquery');
const root = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*'\.\/connectionutil\.js';/, '')
    .split('(async function init() {')[0];

async function flush() {
    for (let i = 0; i < 25; i++) await Promise.resolve();
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture() {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'settings.html'), 'utf8'), {
        url: 'http://localhost:8000/', runScripts: 'dangerously',
    });
    const $ = jquery(dom.window);
    const timers = new Set(), commands = [], saves = [], requests = [], toasts = [], injections = [];
    const settings = {};
    const state = { now: 0, send: null, command: null, save: null, fileInput: null };
    let active;
    function chat(id) {
        const value = {
            chatId: id, characterId: 1, groupId: null,
            chatMetadata: {}, extensionSettings: settings, name1: 'Player',
            chat: Array.from({ length: 6 }, (_, i) => ({
                is_user: i % 2 === 0, is_system: false, mes: `${id}:message-${i}`,
            })),
            saveSettingsDebounced() {},
            setExtensionPrompt(name, text) { injections.push({ chat: active.chatId, text }); },
            async saveMetadata() {
                saves.push(active.chatId);
                if (state.save) await state.save(value);
            },
            async executeSlashCommandsWithOptions(command) {
                commands.push({ chat: active.chatId, command });
                const match = /^\/(unhide|hide) (\d+)(?:-(\d+))?$/.exec(command);
                if (match) {
                    const end = Number(match[3] ?? match[2]);
                    for (let i = Number(match[2]); i <= end; i++) {
                        if (active.chat[i]) active.chat[i].is_system = match[1] === 'hide';
                    }
                }
                if (state.command) await state.command(command, value);
            },
        };
        return value;
    }
    const a = chat('A'), b = chat('B');
    active = a;
    const context = { getContext: () => ({ ...active }) };
    const originalCreate = dom.window.document.createElement.bind(dom.window.document);
    dom.window.document.createElement = function (tag, ...args) {
        const element = originalCreate(tag, ...args);
        if (tag === 'input') state.fileInput = element;
        return element;
    };
    const sandbox = {
        window: dom.window, document: dom.window.document, $, structuredClone,
        AbortController, Blob, URL, confirm: () => true,
        console: { log() {}, warn() {}, error() {} },
        toastr: new Proxy({}, { get: (_, level) => (message, title, options) => {
            toasts.push({ level, message, options });
            return dom.window.document.createElement('div');
        } }),
        setTimeout(callback, ms) {
            const timer = { callback, due: state.now + ms, ms };
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer) { timers.delete(timer); },
        SillyTavern: context,
        sendSummarizerRequest(...args) {
            const request = { args, ...deferred() };
            requests.push(request);
            return state.send ? state.send(...args) : request.promise;
        },
    };
    const vmContext = vm.createContext(sandbox);
    vm.runInContext(`'use strict';\n${indexSource}`, vmContext, { filename: 'index.js' });
    const run = code => vm.runInContext(code, vmContext);
    run('Object.assign(getSettings(), { turnsPerSummary: 1, verbatimTurns: 1, connectionSource: "openai" })');
    return {
        dom, $, a, b, state, timers, commands, saves, requests, toasts, injections, context, run, flush,
        activate(chat) { active = chat; },
        async advance(ms) {
            const target = state.now + ms;
            let iterations = 0;
            while (true) {
                const next = [...timers].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due)[0];
                if (!next) break;
                if (++iterations > 1000) throw new Error('Timer loop did not terminate');
                timers.delete(next);
                state.now = next.due;
                const result = next.callback();
                if (result?.catch) result.catch(error => { state.timerError = error; });
                await flush();
                if (state.timerError) throw state.timerError;
            }
            state.now = target;
            await flush();
        },
        async click(selector) {
            const element = $(selector)[0];
            const own = $._data(element, 'events')?.click?.[0];
            const delegated = $._data(dom.window.document, 'events')?.click?.find(event => event.selector === selector);
            const handler = own || delegated;
            if (!handler) throw new Error(`No click handler for ${selector}`);
            return await handler.handler.call(element, $.Event('click'));
        },
        store(chat = active) { return chat.chatMetadata.summaryception; },
        scope() { return run('captureChatScope()'); },
        async import(data) {
            run('bindUIEvents()');
            await this.click('#sc_import');
            const input = state.fileInput;
            return await input.onchange({ target: { files: [{ size: 100, text: async () => JSON.stringify(data) }] } });
        },
        close() { timers.clear(); dom.window.close(); },
    };
}

function transportFixture(overrides = {}) {
    const source = fs.readFileSync(path.join(root, 'connectionutil.js'), 'utf8')
        .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, '')
        .replace(/export\s*\{[^}]*\};/g, '');
    const sandbox = {
        console: { log() {}, warn() {}, error() {} }, TextDecoder,
        SillyTavern: { getContext: () => ({}) },
        ...overrides,
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context, { filename: 'connectionutil.js' });
    return vm.runInContext('({ sendSummarizerRequest, testOpenAIConnection })', context);
}
module.exports = { fixture, transportFixture, deferred, flush };
