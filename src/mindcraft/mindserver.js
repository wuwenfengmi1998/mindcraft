import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
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

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

export function getAgentSettings(agentName) {
    return agent_connections[agentName]?.settings || null;
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
            if (!settings.profile?.name) {
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
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
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

        socket.on('set-agent-settings', (agentName, settings, callback) => {
            const agent = agent_connections[agentName];
            if (!agent) {
                callback?.({ success: false, error: `未找到机器人“${agentName}”` });
                return;
            }
            const modelError = validateProfileModels(settings.profile);
            if (modelError) {
                console.error(`Rejected settings for ${agentName}: ${modelError}`);
                callback?.({ success: false, error: modelError });
                return;
            }
            agent.setSettings(settings);
            if (agent.socket) agent.socket.emit('restart-agent');
            callback?.({ success: true });
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            const agent = agent_connections[agentName];
            if (agent?.socket) agent.socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', async (agentName, callback) => {
            const result = await mindcraft.startAgent(agentName);
            if (typeof callback === 'function') callback(result);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
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
            viewerPort: conn.viewer_port,
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