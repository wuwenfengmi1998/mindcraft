import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import httpProxy from 'http-proxy';
import path from 'path';
import os from 'os';
import process from 'node:process';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync } from 'fs';
import {
    loadProviders,
    saveProviders,
    getProvider,
    sanitizeProvider,
    generateProviderId,
    validateProviderInput,
} from '../utils/providers.js';
import {
    loadAccounts,
    sanitizeAccount,
    createOfflineAccount,
    deleteAccount,
    getAccount,
    accountCacheExists,
} from '../utils/accounts.js';
import { startMicrosoftLogin, getMicrosoftLoginStatus, cancelMicrosoftLogin } from './microsoftAuth.js';
import { upsertBotSettings, removeBotSettings, getBotsUsingAccount } from './botRegistry.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

async function fetchModelsFromProvider(provider) {
    const base = String(provider.url || '').replace(/\/+$/, '');
    if (!base) {
        throw new Error('供应商 URL 为空');
    }

    const endpoints = [];
    if (/\/models$/.test(base)) {
        endpoints.push(base);
    } else {
        endpoints.push(`${base}/models`);
        if (!/\/v1$/.test(base)) {
            endpoints.push(`${base}/v1/models`);
        }
    }

    let lastError = null;
    for (const endpoint of endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const headers = { Accept: 'application/json' };
            if (provider.apiKey) {
                headers.Authorization = `Bearer ${provider.apiKey}`;
            }
            const response = await fetch(endpoint, { headers, signal: controller.signal });
            const text = await response.text();
            if (!response.ok) {
                let detail = text.slice(0, 300).trim();
                try {
                    const parsed = JSON.parse(text);
                    detail = parsed?.error?.message || parsed?.message || detail;
                } catch { /* ignore */ }
                lastError = new Error(`请求模型列表失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
                continue;
            }

            let data;
            try {
                data = JSON.parse(text);
            } catch {
                lastError = new Error('模型列表响应不是 JSON');
                continue;
            }

            const rawList = Array.isArray(data)
                ? data
                : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []));
            const models = [...new Set(rawList
                .map(item => (typeof item === 'string' ? item : item?.id || item?.name || item?.model || null))
                .filter(Boolean)
                .map(name => String(name).trim())
                .filter(Boolean))].sort((a, b) => a.localeCompare(b));

            if (!models.length) {
                lastError = new Error('模型列表为空');
                continue;
            }
            return models;
        } catch (err) {
            lastError = err.name === 'AbortError'
                ? new Error('请求模型列表超时（15 秒）')
                : err;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError || new Error('无法获取模型列表');
}

function getModelProviderId(value) {
    if (typeof value === 'string') {
        if (value.startsWith('custom-') && value.includes('/')) {
            return value.split('/')[0];
        }
        return null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.api === 'string') {
        return value.api;
    }
    return null;
}

function validateModelSpec(value, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        return { valid: !required, providerId: null };
    }
    if (typeof value === 'string') {
        return { valid: value.trim().length > 0, providerId: getModelProviderId(value) };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const valid = typeof value.model === 'string' && value.model.trim().length > 0;
        return { valid, providerId: getModelProviderId(value) };
    }
    return { valid: false, providerId: null };
}

function validateProfileModels(profile) {
    const chatModel = validateModelSpec(profile?.model, { required: true });
    if (!chatModel.valid) {
        return '机器人配置中必须包含有效的模型';
    }
    const optionalModelFields = [
        ['code_model', '代码模型'],
        ['vision_model', '视觉模型'],
        ['embedding', '嵌入模型'],
    ];
    for (const [field, label] of optionalModelFields) {
        const result = validateModelSpec(profile?.[field]);
        if (!result.valid) {
            return `${label}格式无效`;
        }
        if (result.providerId && result.providerId.startsWith('custom-') && !getProvider(result.providerId)) {
            return `所选${label}供应商不存在，请刷新后重试`;
        }
    }
    if (chatModel.providerId && chatModel.providerId.startsWith('custom-') && !getProvider(chatModel.providerId)) {
        return '所选对话模型供应商不存在，请刷新后重试';
    }
    return null;
}

function applyAccountToSettings(settings) {
    const accountId = settings?.account_id;
    if (!accountId) return null;
    const account = getAccount(accountId);
    if (!account) {
        throw new Error('所选账号不存在');
    }
    if (account.type === 'microsoft' && !accountCacheExists(account.id)) {
        throw new Error('所选 Microsoft 账号尚未登录，请先在账号配置中重新登录');
    }
    settings.auth = account.type === 'microsoft' ? 'microsoft' : 'offline';
    if (!settings.profile) {
        throw new Error('机器人配置缺失');
    }
    settings.profile.name = account.name;
    return account;
}

class AgentConnection {
    constructor(settings) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.starting = false;
        this.cancelled = false;
        this.startAttempt = null;
        this.viewer = null;
        this.full_state = null;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings) {
    let agentConnection = new AgentConnection(settings);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agent_connections[agentName].starting = false;
        agent_connections[agentName].viewer = null;
        agentsStatusUpdate();
    }
}

export function getAgentSettings(agentName) {
    return agent_connections[agentName]?.settings || null;
}

// Viewer processes report a Unix socket path (or a Windows named pipe), never
// a TCP port. Only accept paths inside the OS temp directory so an agent
// cannot point MindServer's proxy at arbitrary local services.
function normalizeViewerSocketPath(value) {
    if (typeof value !== 'string') return null;
    const socketPath = value.trim();
    if (!socketPath || socketPath.length > 256) return null;
    if (process.platform === 'win32') {
        return socketPath.startsWith('\\\\.\\pipe\\') ? socketPath : null;
    }
    if (!path.isAbsolute(socketPath)) return null;
    const tmpDir = os.tmpdir();
    const prefix = tmpDir.endsWith(path.sep) ? tmpDir : tmpDir + path.sep;
    return socketPath.startsWith(prefix) ? socketPath : null;
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    server = http.createServer(app);
    io = new Server(server);

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Path-based reverse proxy for per-agent prismarine-viewer servers.
    const viewerProxy = httpProxy.createProxyServer({ ws: true });
    viewerProxy.on('error', (err, req, res) => {
        // Closing/refreshing an iframe commonly aborts in-flight requests.
        if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
            console.error('Viewer proxy error:', err.message);
        }
        if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Viewer proxy error');
        } else if (res && typeof res.destroy === 'function') {
            res.destroy();
        }
    });

    app.use('/viewer/:agent', (req, res) => {
        const connection = agent_connections[req.params.agent];
        const viewer = connection?.viewer;
        if (viewer?.state !== 'ready' || !viewer.socketPath) {
            res.status(503).send('机器人视角尚未就绪');
            return;
        }
        // Express strips the mounted prefix from req.url.
        viewerProxy.web(req, res, { target: { socketPath: viewer.socketPath } });
    });

    server.on('upgrade', (req, socket, head) => {
        let parsed;
        try {
            parsed = new URL(req.url, 'http://localhost');
        } catch {
            return;
        }
        const match = parsed.pathname.match(/^\/viewer\/([^/]+)(\/.*)?$/);
        if (!match) {
            return;
        }
        const agentName = decodeURIComponent(match[1]);
        const connection = agent_connections[agentName];
        const viewer = connection?.viewer;
        if (viewer?.state !== 'ready' || !viewer.socketPath) {
            socket.destroy();
            return;
        }
        req.url = `${match[2] || '/'}${parsed.search}`;
        try {
            viewerProxy.ws(req, socket, head, { target: { socketPath: viewer.socketPath } });
        } catch (err) {
            console.error('Viewer WebSocket proxy error:', err.message);
            socket.destroy();
        }
    });

    // Model provider management API
    app.get('/api/providers', (req, res) => {
        const providers = loadProviders();
        res.json({ providers: providers.map(sanitizeProvider) });
    });

    app.post('/api/providers', (req, res) => {
        try {
            const providers = loadProviders();
            const input = validateProviderInput(req.body || {}, null, providers);
            const provider = {
                id: generateProviderId(input.name, providers.map(item => item.id)),
                name: input.name,
                url: input.url,
                apiKey: input.apiKey,
                models: [],
                modelsFetchedAt: null,
            };
            providers.push(provider);
            saveProviders(providers);
            res.json({ provider: sanitizeProvider(provider) });
        } catch (err) {
            res.status(400).json({ error: err.message || '新增供应商失败' });
        }
    });

    app.put('/api/providers/:id', (req, res) => {
        try {
            const providers = loadProviders();
            const index = providers.findIndex(provider => provider.id === req.params.id);
            if (index === -1) {
                res.status(404).json({ error: '供应商不存在' });
                return;
            }
            const existing = providers[index];
            const input = validateProviderInput(req.body || {}, existing, providers);
            const connectionChanged = input.url !== existing.url || input.apiKey !== existing.apiKey;
            const updated = {
                ...existing,
                name: input.name,
                url: input.url,
                apiKey: input.apiKey,
            };
            if (connectionChanged) {
                updated.models = [];
                updated.modelsFetchedAt = null;
            }
            providers[index] = updated;
            saveProviders(providers);
            res.json({ provider: sanitizeProvider(updated) });
        } catch (err) {
            res.status(400).json({ error: err.message || '保存供应商失败' });
        }
    });

    app.delete('/api/providers/:id', (req, res) => {
        try {
            const providers = loadProviders();
            const index = providers.findIndex(provider => provider.id === req.params.id);
            if (index === -1) {
                res.status(404).json({ error: '供应商不存在' });
                return;
            }
            const [removed] = providers.splice(index, 1);
            saveProviders(providers);
            res.json({ success: true, provider: sanitizeProvider(removed) });
        } catch (err) {
            res.status(500).json({ error: err.message || '删除供应商失败' });
        }
    });

    app.post('/api/providers/fetch-all-models', async (req, res) => {
        try {
            const providers = loadProviders();
            const results = [];
            for (const provider of providers) {
                try {
                    const models = await fetchModelsFromProvider(provider);
                    provider.models = models;
                    provider.modelsFetchedAt = new Date().toISOString();
                    results.push({ id: provider.id, name: provider.name, success: true, count: models.length });
                } catch (err) {
                    results.push({ id: provider.id, name: provider.name, success: false, error: err.message || '拉取模型失败' });
                }
            }
            saveProviders(providers);
            res.json({ results, providers: providers.map(sanitizeProvider) });
        } catch (err) {
            res.status(500).json({ error: err.message || '拉取模型失败' });
        }
    });

    app.post('/api/providers/:id/fetch-models', async (req, res) => {
        try {
            const providers = loadProviders();
            const provider = providers.find(item => item.id === req.params.id);
            if (!provider) {
                res.status(404).json({ error: '供应商不存在' });
                return;
            }
            const models = await fetchModelsFromProvider(provider);
            provider.models = models;
            provider.modelsFetchedAt = new Date().toISOString();
            saveProviders(providers);
            res.json({ provider: sanitizeProvider(provider) });
        } catch (err) {
            res.status(502).json({ error: err.message || '拉取模型失败' });
        }
    });

    // Account management API
    app.get('/api/accounts', (req, res) => {
        res.json({ accounts: loadAccounts().map(sanitizeAccount) });
    });

    app.post('/api/accounts/offline', (req, res) => {
        try {
            const account = createOfflineAccount(req.body?.name);
            res.json({ account: sanitizeAccount(account) });
        } catch (err) {
            res.status(400).json({ error: err.message || '添加离线账号失败' });
        }
    });

    app.delete('/api/accounts/:id', (req, res) => {
        try {
            const usedBy = new Set(getBotsUsingAccount(req.params.id).map(bot => bot.name));
            for (const [name, connection] of Object.entries(agent_connections)) {
                if (connection.settings?.account_id === req.params.id) {
                    usedBy.add(name);
                }
            }
            if (usedBy.size > 0) {
                res.status(400).json({
                    error: `该账号正在被机器人使用：${[...usedBy].join('、')}。请先修改或移除这些机器人。`,
                });
                return;
            }
            const removed = deleteAccount(req.params.id);
            if (!removed) {
                res.status(404).json({ error: '账号不存在' });
                return;
            }
            res.json({ success: true, account: sanitizeAccount(removed) });
        } catch (err) {
            res.status(500).json({ error: err.message || '删除账号失败' });
        }
    });

    app.post('/api/accounts/microsoft/start', async (req, res) => {
        try {
            const accountId = req.body?.accountId || null;
            const flow = await startMicrosoftLogin(accountId);
            res.json(flow);
        } catch (err) {
            res.status(400).json({ error: err.message || '启动 Microsoft 登录失败' });
        }
    });

    app.get('/api/accounts/microsoft/status/:flowId', (req, res) => {
        const flow = getMicrosoftLoginStatus(req.params.flowId);
        if (!flow) {
            res.status(404).json({ error: '登录流程不存在或已过期' });
            return;
        }
        res.json(flow);
    });

    app.post('/api/accounts/microsoft/cancel/:flowId', (req, res) => {
        const flow = cancelMicrosoftLogin(req.params.flowId);
        if (!flow) {
            res.status(404).json({ error: '登录流程不存在或已过期' });
            return;
        }
        res.json(flow);
    });

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('26.1');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `缺少必填设置：${settings_spec[key].label || key}` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (!settings.profile) {
                callback({ success: false, error: '机器人配置缺失' });
                return;
            }
            try {
                applyAccountToSettings(settings);
            } catch (err) {
                callback({ success: false, error: err.message || '账号配置无效' });
                return;
            }
            if (!settings.profile.name) {
                console.error('机器人配置中必须包含名称');
                callback({ success: false, error: '机器人配置中必须包含名称' });
                return;
            }
            const modelError = validateProfileModels(settings.profile);
            if (modelError) {
                console.error(modelError);
                callback({ success: false, error: modelError });
                return;
            }
            if (settings.profile.name in agent_connections) {
                callback({ success: false, error: '机器人已存在' });
                return;
            }
            let returned = await mindcraft.createAgent(settings);
            if (returned.success) {
                upsertBotSettings(settings);
            }
            callback({ success: returned.success, error: returned.error });
            let name = settings.profile.name;
            if (!returned.success && agent_connections[name]) {
                mindcraft.destroyAgent(name);
                delete agent_connections[name];
            }
            agentsStatusUpdate();
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `未找到机器人“${agentName}”` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                if (agent_connections[agentName].cancelled) {
                    return;
                }
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].starting = false;
                agent_connections[agentName].viewer = null;
                agentsStatusUpdate();
            }
        });

        socket.on('viewer-status', (agentName, status) => {
            const connection = agent_connections[agentName];
            if (!connection || connection.cancelled) return;
            if (curAgentName && curAgentName !== agentName) return;
            const allowedStates = new Set(['disabled', 'starting', 'ready', 'unsupported', 'error']);
            let state = allowedStates.has(status?.state) ? status.state : 'error';
            let error = status?.error ? String(status.error).slice(0, 500) : null;
            const socketPath = normalizeViewerSocketPath(status?.socketPath);
            if (state === 'ready' && !socketPath) {
                state = 'error';
                error = error || '视角服务 socket 路径无效';
            }
            connection.viewer = {
                state,
                socketPath: state === 'ready' ? socketPath : null,
                error,
                botVersion: status?.botVersion ? String(status.botVersion) : null,
                viewerVersion: status?.viewerVersion ? String(status.viewerVersion) : null,
                updatedAt: new Date().toISOString(),
            };
            agentsStatusUpdate();
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                if (agent_connections[agentName].cancelled) {
                    return;
                }
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                agent_connections[agentName].starting = false;
                agent_connections[agentName].viewer = null;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].starting = false;
                agent_connections[curAgentName].viewer = null;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            if (!agent_connections[agentName].socket) {
                console.warn(`Agent ${agentName} is not connected to MindServer`);
                return;
            }
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', async (agentName, settings, callback) => {
            const agent = agent_connections[agentName];
            if (!agent) {
                callback?.({ success: false, error: `未找到机器人“${agentName}”` });
                return;
            }
            if (!settings.profile) {
                callback?.({ success: false, error: '机器人配置缺失' });
                return;
            }
            try {
                applyAccountToSettings(settings);
            } catch (err) {
                callback?.({ success: false, error: err.message || '账号配置无效' });
                return;
            }
            const modelError = validateProfileModels(settings.profile);
            if (modelError) {
                console.error(`Rejected settings for ${agentName}: ${modelError}`);
                callback?.({ success: false, error: modelError });
                return;
            }

            const newName = settings.profile.name;
            if (!newName) {
                callback?.({ success: false, error: '机器人名称不能为空' });
                return;
            }

            if (newName !== agentName) {
                if (agent_connections[newName]) {
                    callback?.({ success: false, error: '新账号对应的机器人名称已存在' });
                    return;
                }
                const wasRunning = !!agent.socket || agent.in_game;
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];

                let returned;
                try {
                    returned = await mindcraft.createAgent(settings);
                } catch (err) {
                    returned = { success: false, error: err.message };
                }
                if (!returned.success) {
                    callback?.({ success: false, error: returned.error || '修改机器人账号失败' });
                    agentsStatusUpdate();
                    return;
                }

                removeBotSettings(agentName);
                upsertBotSettings(settings);

                const newConnection = agent_connections[newName];
                const shouldStart = !mindcraft.isManualStart() || wasRunning;
                if (newConnection && shouldStart && !newConnection.socket && !newConnection.in_game) {
                    newConnection.starting = true;
                    agentsStatusUpdate();
                }

                if (mindcraft.isManualStart() && wasRunning) {
                    const started = await mindcraft.startAgent(newName);
                    if (!started.success) {
                        if (newConnection) {
                            newConnection.starting = false;
                        }
                        callback?.({
                            success: true,
                            renamed: true,
                            name: newName,
                            warning: started.error || '机器人已改名，但自动启动失败，请手动点击“连接”。',
                        });
                        agentsStatusUpdate();
                        return;
                    }
                }
                callback?.({ success: true, renamed: true, name: newName });
                agentsStatusUpdate();
                return;
            }

            agent.setSettings(settings);
            upsertBotSettings(settings);
            agent.viewer = null;
            if (agent.socket) agent.socket.emit('restart-agent');
            callback?.({ success: true });
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            const agent = agent_connections[agentName];
            if (agent?.socket) agent.socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.starting = false;
                agent.in_game = false;
                agent.cancelled = true;
                agent.startAttempt = null;
                agent.viewer = null;
                agent.socket = null;
            }
            mindcraft.cancelAgentStart(agentName);
            agentsStatusUpdate();
        });

        socket.on('start-agent', async (agentName, callback) => {
            const agent = agent_connections[agentName];
            if (!agent) {
                callback?.({ success: false, error: `未找到机器人“${agentName}”` });
                return;
            }
            if (agent.in_game) {
                callback?.({ success: true });
                return;
            }
            if (agent.starting || agent.socket) {
                callback?.({ success: true, alreadyStarting: true });
                return;
            }
            const attempt = Symbol('start-agent');
            agent.startAttempt = attempt;
            agent.cancelled = false;
            agent.starting = true;
            agent.viewer = null;
            agentsStatusUpdate();
            let result;
            try {
                result = await mindcraft.startAgent(agentName);
            } catch (err) {
                result = { success: false, error: err.message || '连接失败' };
            }
            const current = agent_connections[agentName];
            if (!current || current.startAttempt !== attempt) {
                if (typeof callback === 'function') callback(result);
                return;
            }
            current.startAttempt = null;
            if (!result.success) {
                current.starting = false;
            }
            agentsStatusUpdate();
            if (typeof callback === 'function') callback(result);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            removeBotSettings(agentName);
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                agent_connections[agentName].starting = false;
                agent_connections[agentName].cancelled = true;
                agent_connections[agentName].startAttempt = null;
                agent_connections[agentName].in_game = false;
                agent_connections[agentName].viewer = null;
                agent_connections[agentName].socket = null;
                mindcraft.cancelAgentStart(agentName);
            }
            agentsStatusUpdate();
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                agent_connections[agentName].starting = false;
                agent_connections[agentName].cancelled = true;
                agent_connections[agentName].startAttempt = null;
                mindcraft.cancelAgentStart(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]?.socket) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function publicViewer(viewer) {
    if (!viewer) return null;
    return {
        state: viewer.state,
        error: viewer.error,
        botVersion: viewer.botVersion,
        viewerVersion: viewer.viewerVersion,
        updatedAt: viewer.updatedAt,
    };
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            starting: conn.starting,
            viewer: publicViewer(conn.viewer),
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;