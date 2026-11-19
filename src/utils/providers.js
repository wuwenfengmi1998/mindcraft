import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import process from 'node:process';
import path from 'path';

const providersPath = path.join(process.cwd(), 'providers.json');

export function getProvidersPath() {
    return providersPath;
}

export function loadProviders() {
    try {
        const raw = readFileSync(providersPath, 'utf8');
        const data = JSON.parse(raw);
        const providers = Array.isArray(data) ? data : data.providers;
        if (!Array.isArray(providers)) return [];
        return providers.filter(provider =>
            provider && typeof provider === 'object' && typeof provider.id === 'string' && provider.id.length > 0
        );
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('Failed to read providers.json:', err.message);
        }
        return [];
    }
}

export function saveProviders(providers) {
    const data = `${JSON.stringify({ providers }, null, 4)}\n`;
    const tmpPath = `${providersPath}.tmp`;
    try {
        writeFileSync(tmpPath, data, 'utf8');
        renameSync(tmpPath, providersPath);
    } catch (err) {
        // Fall back to a direct write if rename is not available (e.g. some Windows setups).
        try {
            unlinkSync(tmpPath);
        } catch { /* ignore */ }
        writeFileSync(providersPath, data, 'utf8');
    }
}

export function getProvider(id) {
    return loadProviders().find(provider => provider.id === id) || null;
}

export function slugifyProviderName(name) {
    return String(name || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

export function generateProviderId(name, existingIds = []) {
    const base = slugifyProviderName(name) || 'provider';
    const used = new Set(existingIds);
    let id = `custom-${base}`;
    let suffix = 2;
    while (used.has(id)) {
        id = `custom-${base}-${suffix++}`;
    }
    return id;
}

export function maskApiKey(apiKey) {
    if (!apiKey) return '';
    const key = String(apiKey);
    if (key.length <= 8) return '••••••';
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function sanitizeProvider(provider) {
    return {
        id: provider.id,
        name: provider.name || provider.id,
        url: provider.url || '',
        hasApiKey: Boolean(provider.apiKey),
        apiKeyMasked: maskApiKey(provider.apiKey),
        models: Array.isArray(provider.models) ? provider.models : [],
        modelsFetchedAt: provider.modelsFetchedAt || null,
    };
}

export function normalizeProviderUrl(rawUrl) {
    const url = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!url) {
        throw new Error('请填写供应商 URL');
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('供应商 URL 格式无效');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('供应商 URL 只支持 http 或 https');
    }
    return url;
}

export function validateProviderInput(input, existing, providers) {
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name) {
        throw new Error('请填写供应商名称');
    }
    const duplicate = providers.find(provider =>
        provider.id !== existing?.id && String(provider.name || '').toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
        throw new Error('供应商名称已存在');
    }

    const url = normalizeProviderUrl(input.url ?? existing?.url ?? '');

    let apiKey = existing?.apiKey || '';
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
        const newKey = String(input.apiKey ?? '').trim();
        if (newKey !== '') {
            apiKey = newKey;
        }
    }

    return { name, url, apiKey };
}
