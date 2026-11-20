import { fetchOllamaModels, testOpenAIConnection, populateProfileDropdown } from './connectionutil.js';

const CONNECTION_STATUS_TIMEOUT_MS = 8_000;
let connectionRevision = 0;
let statusTimer;

function invalidateConnectionStatus() {
    connectionRevision++;
    clearTimeout(statusTimer);
    $('#summaryception_connection_status').hide();
}

export function initConnectionUI(getSettings, saveSettings) {

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = getSettings().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            invalidateConnectionStatus();
            getSettings().connectionSource = sourceSelect.value;
            saveSettings();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, getSettings().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, getSettings().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            getSettings().connectionProfileId = profileSelect.value;
            saveSettings();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = getSettings().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            invalidateConnectionStatus();
            getSettings().ollamaUrl = ollamaUrl.value.trim();
            getSettings().ollamaModelsCache = [];
            if (ollamaModel) populateOllamaModelDropdown(ollamaModel, [], getSettings().ollamaModel);
            saveSettings();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, getSettings().ollamaModelsCache || [], getSettings().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            getSettings().ollamaModel = ollamaModel.value;
            saveSettings();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels(getSettings(), saveSettings);
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = getSettings().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            invalidateConnectionStatus();
            getSettings().openaiUrl = openaiUrl.value.trim();
            saveSettings();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = getSettings().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            invalidateConnectionStatus();
            getSettings().openaiKey = openaiKey.value.trim();
            saveSettings();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = getSettings().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            invalidateConnectionStatus();
            getSettings().openaiModel = openaiModel.value.trim();
            saveSettings();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = getSettings().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            getSettings().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            saveSettings();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler(getSettings());
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(getSettings().connectionSource || 'default');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile: document.getElementById('summaryception_profile_settings'),
        ollama: document.getElementById('summaryception_ollama_settings'),
        openai: document.getElementById('summaryception_openai_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- 选择模型 --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels(s, saveSettings) {
    const revision = ++connectionRevision;
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', '正在获取 Ollama 模型…');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        if (revision !== connectionRevision) return;
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `找到 ${models.length} 个模型`);
        toastr.success(`找到 ${models.length} 个 Ollama 模型`, 'Summaryception');
    } catch (error) {
        if (revision !== connectionRevision) return;
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `失败：${error.message}`);
        toastr.error(`获取 Ollama 模型失败：${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler(s) {
    const revision = ++connectionRevision;

    if (!s.openaiUrl) {
        toastr.warning('请先输入端点 URL。', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('请先输入模型名称。', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', '正在测试连接…');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (revision !== connectionRevision) return;
    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    clearTimeout(statusTimer);
    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        statusTimer = setTimeout(() => {
            if (container) container.style.display = 'none';
        }, CONNECTION_STATUS_TIMEOUT_MS);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- 选择连接配置 --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}
