/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default:  SillyTavern's generateRaw() (active connection)
 *   - profile:  ST Connection Profile via ConnectionManagerRequestService
 *   - ollama:   Ollama instance (via ST CORS proxy to avoid browser CORS issues)
 *   - openai:   OpenAI-compatible endpoint (via ST CORS proxy, streaming supported)
 *
 * CORS Note: Ollama and OpenAI modes route through ST's /cors/ proxy endpoint
 * to avoid browser CORS restrictions. Requires enableCorsProxy: true in config.yaml
 * OR the target server must have permissive CORS headers.
 *
 * AGPL-3.0
 */

const MODULE_NAME = '[Summaryception][Connection]';

// ═══════════════════════════════════════════════════════════════════════
//  LLM_DEFAULTS — Centralised connection-side constants.
//  Tweak sampling parameters and limits here instead of inside functions.
// ═══════════════════════════════════════════════════════════════════════

const LLM_DEFAULTS = Object.freeze({
    ollamaTemperature:    0.3,    // Lower = more deterministic summaries
    openaiTemperature:    0.8,    // Slightly creative for narrative flow
    testMaxTokens:        100,    // Small ceiling for the "Test Connection" probe
    testPreviewLength:    100,    // Characters of response shown in test result toast
});

// ─── Custom Error Class ──────────────────────────────────────────────

/**
 * Error class for connection errors with explicit retryable flag.
 * The retry logic in callSummarizer checks for this to avoid
 * burning through retries on errors that will never succeed
 * (e.g. missing config, auth failures, deleted profiles).
 */
class ConnectionError extends Error {
    constructor(message, { retryable = false, status = null } = {}) {
        super(message);
        this.name = 'ConnectionError';
        this.retryable = retryable;
        this.status = status;
    }
}

export { ConnectionError };

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Request cancelled');
    error.name = 'AbortError';
    throw error;
}

// ─── CORS Proxy Helper ───────────────────────────────────────────────

/**
 * Wrap a URL through SillyTavern's CORS proxy if needed.
 * @param {string} url - The target URL
 * @param {boolean} useProxy - Whether to attempt proxying
 * @returns {string} - The (possibly proxied) URL
 */
function proxiedUrl(url, useProxy = true) {
    if (!useProxy) return url;
    return `/proxy/${url}`;
}

/**
 * Get standard request headers including ST's CSRF token if available.
 * Required when routing through ST's /cors/ proxy.
 * @returns {object}
 */
function getProxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (e) { /* fallback */ }
    return { 'Content-Type': 'application/json' };
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Send a summarization request using the configured connection.
 * @param {object} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @param {{signal?: AbortSignal}} options - Cancellation for the whole operation
 * @returns {Promise<string>} - The generated response text
 * @throws {ConnectionError|Error} - If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt, { signal } = {}) {
    throwIfAborted(signal);
    const source = settings.connectionSource || 'default';

    switch (source) {
        case 'profile':
            return await sendViaProfile(settings.connectionProfileId, systemPrompt, userPrompt, signal);
        case 'ollama':
            return await sendViaOllama(settings.ollamaUrl, settings.ollamaModel, systemPrompt, userPrompt, signal);
        case 'openai':
            return await sendViaOpenAI(settings.openaiUrl, settings.openaiKey, settings.openaiModel, systemPrompt, userPrompt, settings.openaiMaxTokens, signal);
        case 'default':
        default:
            return await sendViaDefault(systemPrompt, userPrompt, settings.summarizerResponseLength, signal);
    }
}

// ─── Mode 1: Default (generateRaw) ──────────────────────────────────

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 */
async function sendViaDefault(systemPrompt, userPrompt, responseLength, signal) {
    const context = SillyTavern.getContext();
    const { generateRaw } = context;

    if (!generateRaw) {
        throw new ConnectionError(
            '当前 SillyTavern 上下文中没有可用的 generateRaw。',
            { retryable: false }
        );
    }

    // ST refactored generateRaw from positional args to an object param
    // in PR #4277 (July 2025). We need to support both signatures.
    //
    // New (July 2025+): generateRaw({ prompt, systemPrompt, responseLength })
    // Old (pre-July 2025): generateRaw(prompt, systemPrompt)
    //
    // Detection: the new signature destructures an object, so if we check
    // the function's length (expected positional params), 0 or 1 means
    // object-style, 2+ means positional-style.

    const onAbort = () => context.stopGeneration?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        throwIfAborted(signal);
        let result;

        if (generateRaw.length <= 1) {
            // Modern ST: object-based params
            const options = {
                systemPrompt: systemPrompt,
                prompt: userPrompt,
            };

            if (responseLength && responseLength > 0) {
                options.responseLength = responseLength;
            }

            result = await generateRaw(options);
        } else {
            // Legacy ST: positional args — generateRaw(prompt, systemPrompt)
            // Note: legacy signature does not support responseLength override
            console.warn(
                '[Summaryception] Detected legacy generateRaw (positional args). ' +
                'Consider updating SillyTavern to July 2025+ for full feature support.'
            );
            result = await generateRaw(userPrompt, systemPrompt);
        }

        if (!result || typeof result !== 'string') {
            throw new ConnectionError(
                'generateRaw 返回了空响应或无效响应。',
                { retryable: true }
            );
        }

        throwIfAborted(signal);
        return result;
    } catch (error) {
        throwIfAborted(signal);
        throw error;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

// ─── Mode 2: Connection Profile ──────────────────────────────────────

/**
 * Uses ST's ConnectionManagerRequestService to send a request via a saved profile.
 * Requires SillyTavern with PR #3603 merged (March 2025+).
 * Full API key support requires staging with Issue #5348 fix (March 30, 2026+).
 *
 * IMPORTANT: sendRequest() expects messages as an array of {role, content} objects,
 * NOT as a generateRaw()-style options object. Passing {systemPrompt, prompt} as
 * the second argument causes the entire object to be stuffed into the message
 * content field, resulting in "Invalid input" / validation errors from the API.
 */
async function sendViaProfile(profileId, systemPrompt, userPrompt, signal) {
    if (!profileId) {
        throw new ConnectionError(
            '未选择连接配置。请在 Summaryception 设置中选择一个。',
            { retryable: false }
        );
    }

    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service) {
        throw new ConnectionError(
            'ConnectionManagerRequestService 不可用。' +
            '你的 SillyTavern 版本可能过旧。需要包含 PR #3603 的 ST（2025 年 3 月及以后）。',
                                  { retryable: false }
        );
    }

    if (typeof service.sendRequest !== 'function') {
        throw new ConnectionError(
            'ConnectionManagerRequestService.sendRequest() 不可用。' +
            '请将 SillyTavern 更新到最新的 staging 版本。',
            { retryable: false }
        );
    }

    try {
        // Build messages as proper {role, content} objects.
        // ST takes maxTokens third and request options fourth.
        // where messages is a string OR an array of {role, content} objects.
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        throwIfAborted(signal);
        const raw = await service.sendRequest(profileId, messages, undefined, {
            includeInstruct: false,
            extractData: true,
            stream: false,
            signal,
        });
        throwIfAborted(signal);

        // Handle various possible return types
        let result;
        if (typeof raw === 'string') {
            result = raw;
        } else if (raw?.content) {
            result = raw.content;
        } else if (raw?.message?.content) {
            result = raw.message.content;
        } else if (raw?.choices?.[0]?.message?.content) {
            result = raw.choices[0].message.content;
        } else if (raw?.data) {
            result = typeof raw.data === 'string' ? raw.data : JSON.stringify(raw.data);
        } else if (raw && typeof raw === 'object') {
            const str = JSON.stringify(raw);
            console.warn('[Summaryception][Connection] Unexpected return type from sendRequest:', str.substring(0, 500));
            throw new ConnectionError(
                `连接配置返回了意外的类型：${typeof raw}。` +
                `预览：${str.substring(0, 200)}。` +
                `请在 Summaryception 的 GitHub 仓库报告此问题。`,
                { retryable: false }
            );
        } else {
            throw new ConnectionError(
                '连接配置返回了空响应或无效响应。',
                { retryable: true }
            );
        }

        if (!result || !result.trim()) {
            throw new ConnectionError(
                '连接配置返回了空响应。',
                { retryable: true }
            );
        }

        return result;

    } catch (error) {
        throwIfAborted(signal);
        if (error.name === 'AbortError' || error instanceof ConnectionError) throw error;

        const msg = error?.message || String(error);
        const status = error?.status || error?.response?.status;

        if (status === 401 || msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
            throw new ConnectionError(
                `连接配置认证失败（401）。这很可能是 API 密钥切换 bug ` +
                `（ST Issue #5348）。请将 SillyTavern 更新到 staging 版（2026 年 3 月 30 日及以后）以修复此问题。` +
                `原始错误：${msg}`,
                { retryable: false, status: 401 }
            );
        }

        if (msg.includes('not found') || msg.includes('profile')) {
            throw new ConnectionError(
                `未找到连接配置“${profileId}”。它可能已被删除。` +
                `请在 Summaryception 设置中重新选择连接配置。`,
                { retryable: false, status: 404 }
            );
        }

        throw new ConnectionError(
            `连接配置请求失败：${msg}`,
            { retryable: true, status: status }
        );
    }
}

// ─── Mode 3: Ollama (Local) ─────────────────────────────────────────

/**
 * Send a request to a local Ollama instance using /api/chat.
 * Routes through ST's CORS proxy to avoid browser CORS restrictions.
 */
async function sendViaOllama(url, model, systemPrompt, userPrompt, signal) {
    if (!url) {
        throw new ConnectionError(
            '未配置 Ollama URL。请在 Summaryception 设置中填写。',
            { retryable: false }
        );
    }
    if (!model) {
        throw new ConnectionError(
            '未选择 Ollama 模型。请在 Summaryception 设置中选择一个。',
            { retryable: false }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/chat`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'POST',
            signal,
            headers: {
                ...getProxyHeaders(),
                               'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: {
                    temperature: LLM_DEFAULTS.ollamaTemperature,
                },
            }),
        });
    } catch (proxyError) {
        throwIfAborted(signal);
        console.warn(`${MODULE_NAME} CORS proxy failed, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'POST',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                    options: { temperature: LLM_DEFAULTS.ollamaTemperature },
                }),
            });
        } catch (directError) {
            throwIfAborted(signal);
            throw new ConnectionError(
                `无法连接到 ${baseUrl} 上的 Ollama。` +
                `CORS 代理错误：${proxyError.message}。直连错误：${directError.message}。` +
                `请确保 config.yaml 中 enableCorsProxy 设为 true，或在 Ollama 实例上设置 OLLAMA_ORIGINS=*。`,
                { retryable: true }
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '未知错误');
        throw new ConnectionError(
            `Ollama 请求失败（${response.status}）：${errorText}`,
                                  { retryable: response.status >= 500, status: response.status }
        );
    }

    const data = await response.json();

    if (!data?.message?.content) {
        throw new ConnectionError(
            'Ollama 返回了空响应或无效响应。',
            { retryable: true }
        );
    }

    return data.message.content;
}

/**
 * Fetch available models from an Ollama instance.
 * @param {string} url - The Ollama base URL
 * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>}
 */
export async function fetchOllamaModels(url) {
    if (!url) {
        throw new Error('未配置 Ollama URL。');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/tags`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'GET',
            headers: getProxyHeaders(),
        });
    } catch (proxyError) {
        console.warn(`${MODULE_NAME} CORS proxy failed for model list, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (directError) {
            throw new Error(
                `无法连接到 ${baseUrl} 上的 Ollama。` +
                `请在 config.yaml 中启用 CORS 代理（enableCorsProxy: true），或在 Ollama 实例上设置 OLLAMA_ORIGINS=*。` +
                `代理错误：${proxyError.message}。直连错误：${directError.message}`
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '未知错误');
        throw new Error(`获取 Ollama 模型失败（${response.status}）：${errorText}`);
    }

    const data = await response.json();

    if (!data?.models || !Array.isArray(data.models)) {
        throw new Error('Ollama /api/tags 返回了意外的响应格式。');
    }

    return data.models;
}

// ─── Mode 4: OpenAI Compatible (Streaming) ──────────────────────────

/**
 * Send a request to any OpenAI-compatible endpoint using streaming.
 * Streaming avoids the non-streaming token ceiling (4096 on many providers)
 * and allows reasoning models to complete their full thinking + output.
 *
 * Routes through ST's CORS proxy for local endpoints.
 * Cloud endpoints skip the proxy since they have CORS headers.
 */
async function sendViaOpenAI(url, apiKey, model, systemPrompt, userPrompt, maxTokens, signal) {
    if (!url) {
        throw new ConnectionError(
            '未配置 OpenAI 兼容 URL。请在 Summaryception 设置中填写。',
            { retryable: false }
        );
    }
    if (!model) {
        throw new ConnectionError(
            '未设置 OpenAI 兼容模型名称。请在 Summaryception 设置中填写。',
            { retryable: false }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');

    // Build the endpoint URL
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) {
            endpoint += '/chat/completions';
        } else if (!endpoint.includes('/chat/completions')) {
            endpoint += '/v1/chat/completions';
        }
    }


    // Decide whether to use CORS proxy
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(endpoint);

    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Use maxTokens from settings, default to 0 (no limit / provider default)
    const tokenLimit = maxTokens && maxTokens > 0 ? maxTokens : undefined;

    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: LLM_DEFAULTS.openaiTemperature,
        stream: true,
    };

    // Only include max_tokens if explicitly set
    if (tokenLimit) {
        requestBody.max_tokens = tokenLimit;
    }

    const body = JSON.stringify(requestBody);

    let response;
    if (isLocal) {
        try {
            response = await fetch(proxiedUrl(endpoint), {
                method: 'POST',
                signal,
                headers: { ...getProxyHeaders(), ...headers },
                                   body: body,
            });
        } catch (proxyError) {
            throwIfAborted(signal);
            console.warn(`${MODULE_NAME} CORS proxy failed for OpenAI endpoint, trying direct:`, proxyError.message);
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    signal,
                    headers: headers,
                    body: body,
                });
            } catch (directError) {
                throwIfAborted(signal);
                throw new ConnectionError(
                    `无法连接到 ${baseUrl}。` +
                    `请在 config.yaml 中启用 CORS 代理（enableCorsProxy: true）。` +
                    `代理错误：${proxyError.message}。直连错误：${directError.message}`,
                    { retryable: true }
                );
            }
        }
    } else {
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                signal,
                headers: headers,
                body: body,
            });
        } catch (directError) {
            throwIfAborted(signal);
            throw new ConnectionError(
                `无法连接到 ${baseUrl}：${directError.message}`,
                { retryable: true }
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '未知错误');
        if (response.status === 401) {
            throw new ConnectionError(
                'OpenAI 兼容端点返回 401 Unauthorized。请检查 API 密钥。',
                { retryable: false, status: 401 }
            );
        }
        if (response.status === 403) {
            throw new ConnectionError(
                `OpenAI 兼容端点返回 403 Forbidden：${errorText}`,
                { retryable: false, status: 403 }
            );
        }
        throw new ConnectionError(
            `OpenAI 兼容请求失败（${response.status}）：${errorText}`,
                                  { retryable: response.status >= 500 || response.status === 429, status: response.status }
        );
    }

    // ─── Stream reading ──────────────────────────────────────────
    // Read SSE chunks and assemble the full response content.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let complete = false;
    let fullContent = '';
    let buffer = '';

    try {
        stream: while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            throwIfAborted(signal);
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = done ? '' : lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;

                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                    complete = true;
                    break stream;
                }

                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    throw new ConnectionError('OpenAI 流返回了无效的数据。', { retryable: true });
                }
                if (parsed?.error) {
                    throw new ConnectionError(parsed.error.message || 'OpenAI 流报告错误。', { retryable: true });
                }
                const choice = parsed?.choices?.[0];
                if (choice?.finish_reason) complete = true;
                const delta = choice?.delta?.content;
                if (delta) fullContent += delta;
            }
            if (done) {
                if (!complete) throw new ConnectionError('OpenAI 流在摘要完成前中断。', { retryable: true });
                break;
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }

    if (!fullContent.trim()) {
        throw new ConnectionError(
            'OpenAI 兼容端点返回了空响应（流式）。',
                                  { retryable: true }
        );
    }

    return fullContent;
}

/**
 * Test the connection to an OpenAI-compatible endpoint.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testOpenAIConnection(url, apiKey, model) {
    try {
        const result = await sendViaOpenAI(
            url,
            apiKey,
            model || 'test',
            'You are a test assistant.',
            'Respond with exactly: CONNECTION_OK',
            LLM_DEFAULTS.testMaxTokens
        );
        return {
            success: true,
            message: `连接成功！响应：“${result.substring(0, LLM_DEFAULTS.testPreviewLength)}”`,
        };
    } catch (error) {
        return {
            success: false,
            message: `连接失败：${error.message}`,
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Populate a <select> element with connection profiles using ST's built-in handler.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} - Whether population succeeded
 */
export function populateProfileDropdown(selectElement, currentValue) {
    try {
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;

        if (service && typeof service.handleDropdown === 'function') {
            service.handleDropdown(selectElement);
            if (currentValue) {
                selectElement.value = currentValue;
            }
            return true;
        }

        console.warn(`${MODULE_NAME} handleDropdown not available.`);
        return false;
    } catch (error) {
        console.error(`${MODULE_NAME} Error populating profile dropdown:`, error);
        return false;
    }
}

/**
 * Get a human-readable name for the current connection source.
 * @param {object} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    switch (settings.connectionSource) {
        case 'default':
            return '默认（主 API）';
        case 'profile':
            return `连接配置：${settings.connectionProfileId || '（无）'}`;
        case 'ollama':
            return `Ollama：${settings.ollamaModel || '（未选择模型）'}`;
        case 'openai':
            return `OpenAI：${settings.openaiModel || '（未选择模型）'}`;
        default:
            return '默认（主 API）';
    }
}
