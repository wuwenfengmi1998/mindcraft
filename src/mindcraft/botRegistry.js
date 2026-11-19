import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import process from 'node:process';
import path from 'path';

const registryPath = path.join(process.cwd(), 'managed-bots.json');

function storageSettings(settings) {
    const copy = JSON.parse(JSON.stringify(settings || {}));
    delete copy.profiles;
    delete copy.mindserver_port;
    delete copy.auto_open_ui;
    return copy;
}

export function getRegistryPath() {
    return registryPath;
}

export function loadBotRegistry() {
    try {
        const raw = readFileSync(registryPath, 'utf8');
        const data = JSON.parse(raw);
        const bots = Array.isArray(data) ? data : data.bots;
        return {
            initialized: true,
            bots: Array.isArray(bots) ? bots.filter(bot =>
                bot && typeof bot === 'object' && typeof bot.name === 'string' && bot.settings
            ) : [],
        };
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('Failed to read managed-bots.json:', err.message);
        }
        return { initialized: false, bots: [] };
    }
}

export function saveBotRegistry(registry) {
    const data = `${JSON.stringify({
        version: 1,
        initialized: true,
        bots: registry.bots || [],
    }, null, 4)}\n`;
    const tmpPath = `${registryPath}.tmp`;
    try {
        writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmpPath, registryPath);
    } catch (err) {
        try {
            unlinkSync(tmpPath);
        } catch { /* ignore */ }
        writeFileSync(registryPath, data, { encoding: 'utf8', mode: 0o600 });
    }
}

export function upsertBotSettings(settings) {
    const name = settings?.profile?.name;
    if (!name) return;
    const registry = loadBotRegistry();
    const stored = {
        name,
        settings: storageSettings(settings),
        updatedAt: new Date().toISOString(),
    };
    const index = registry.bots.findIndex(bot => bot.name === name);
    if (index === -1) {
        registry.bots.push(stored);
    } else {
        registry.bots[index] = stored;
    }
    saveBotRegistry(registry);
    return stored;
}

export function removeBotSettings(name) {
    const registry = loadBotRegistry();
    if (!registry.initialized) return false;
    const next = registry.bots.filter(bot => bot.name !== name);
    if (next.length === registry.bots.length) {
        return false;
    }
    registry.bots = next;
    saveBotRegistry(registry);
    return true;
}

export function getBotSettings(name) {
    return loadBotRegistry().bots.find(bot => bot.name === name)?.settings || null;
}

export function getBotsUsingAccount(accountId) {
    if (!accountId) return [];
    return loadBotRegistry().bots.filter(bot => bot.settings?.account_id === accountId);
}

export function seedBotRegistry(bots) {
    saveBotRegistry({
        initialized: true,
        bots: bots.map(bot => ({
            name: bot.settings.profile.name,
            settings: storageSettings(bot.settings),
            updatedAt: new Date().toISOString(),
        })),
    });
}
