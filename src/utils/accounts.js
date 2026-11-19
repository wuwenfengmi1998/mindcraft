import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import process from 'node:process';
import path from 'path';

const accountsPath = path.join(process.cwd(), 'accounts.json');
const authCacheRoot = path.join(process.cwd(), 'auth-cache');
const OFFLINE_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export function getAccountsPath() {
    return accountsPath;
}

export function getAuthCacheRoot() {
    return authCacheRoot;
}

export function getAccountCacheDir(accountId) {
    return path.join(authCacheRoot, accountId);
}

export function ensureAccountCacheDir(accountId) {
    const dir = getAccountCacheDir(accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}

function removeDir(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.warn('Failed to remove auth cache directory:', dir, err.message);
    }
}

function moveDir(source, target) {
    if (!source || !target || path.resolve(source) === path.resolve(target)) return;
    removeDir(target);
    mkdirSync(path.dirname(target), { recursive: true });
    try {
        renameSync(source, target);
    } catch {
        cpSync(source, target, { recursive: true });
        removeDir(source);
    }
}

export function authCacheFilePrefix(username) {
    return createHash('sha1')
        .update(String(username ?? ''), 'binary')
        .digest('hex')
        .slice(0, 6);
}

export function rekeyAccountCacheDir(dir, accountId) {
    if (!dir || !existsSync(dir)) return;
    const prefix = authCacheFilePrefix(accountId);
    const desiredPrefix = `${prefix}_`;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('-cache.json') || entry.name.startsWith(desiredPrefix)) {
            continue;
        }
        const suffix = entry.name.replace(/^[0-9a-f]{6}_/, '');
        try {
            renameSync(path.join(dir, entry.name), path.join(dir, `${desiredPrefix}${suffix}`));
        } catch (err) {
            console.warn('Failed to rekey auth cache file:', entry.name, err.message);
        }
    }
}

export function loadAccounts() {
    try {
        const raw = readFileSync(accountsPath, 'utf8');
        const data = JSON.parse(raw);
        const accounts = Array.isArray(data) ? data : data.accounts;
        if (!Array.isArray(accounts)) return [];
        return accounts.filter(account =>
            account && typeof account === 'object' && typeof account.id === 'string' && account.id.length > 0
        );
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('Failed to read accounts.json:', err.message);
        }
        return [];
    }
}

export function saveAccounts(accounts) {
    const data = `${JSON.stringify({ accounts }, null, 4)}\n`;
    const tmpPath = `${accountsPath}.tmp`;
    try {
        writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmpPath, accountsPath);
    } catch (err) {
        try {
            unlinkSync(tmpPath);
        } catch { /* ignore */ }
        writeFileSync(accountsPath, data, { encoding: 'utf8', mode: 0o600 });
    }
}

export function getAccount(id) {
    return loadAccounts().find(account => account.id === id) || null;
}

export function formatUuid(id) {
    const hex = String(id || '').replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) {
        return String(id || '');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function offlineUuid(name) {
    const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // IETF variant
    return formatUuid(hash.toString('hex'));
}

export function validateOfflineName(name) {
    const value = String(name || '').trim();
    if (!value) {
        throw new Error('请填写离线账号名称');
    }
    if (!OFFLINE_NAME_PATTERN.test(value)) {
        throw new Error('离线账号名称必须是 3-16 位字母、数字或下划线');
    }
    return value;
}

export function createOfflineAccount(name) {
    const accountName = validateOfflineName(name);
    const accounts = loadAccounts();
    const duplicate = accounts.find(account =>
        account.name.toLowerCase() === accountName.toLowerCase()
    );
    if (duplicate) {
        throw new Error('账号名称已存在');
    }
    const account = {
        id: `acc_${randomUUID()}`,
        type: 'offline',
        name: accountName,
        uuid: offlineUuid(accountName),
        createdAt: new Date().toISOString(),
    };
    accounts.push(account);
    saveAccounts(accounts);
    return account;
}

export function deleteAccount(id) {
    const accounts = loadAccounts();
    const index = accounts.findIndex(account => account.id === id);
    if (index === -1) {
        return null;
    }
    const [removed] = accounts.splice(index, 1);
    saveAccounts(accounts);
    if (removed.type === 'microsoft') {
        removeDir(getAccountCacheDir(removed.id));
    }
    return removed;
}

export function upsertMicrosoftAccount({ existingId, newAccountId, uuid, name, skinUrl, skinVariant, capeUrl, sourceCacheDir }) {
    const normalizedUuid = formatUuid(uuid);
    if (!normalizedUuid || !name) {
        throw new Error('未能获取完整的 Minecraft 账号资料');
    }

    const accounts = loadAccounts();
    let account = existingId
        ? accounts.find(item => item.id === existingId)
        : accounts.find(item => item.uuid.toLowerCase() === normalizedUuid.toLowerCase());

    if (existingId && !account) {
        throw new Error('在线账号不存在');
    }

    if (account) {
        const targetDir = getAccountCacheDir(account.id);
        moveDir(sourceCacheDir, targetDir);
        rekeyAccountCacheDir(targetDir, account.id);
        Object.assign(account, {
            type: 'microsoft',
            name,
            uuid: normalizedUuid,
            skinUrl: skinUrl || null,
            skinVariant: skinVariant || null,
            capeUrl: capeUrl || null,
            lastLoginAt: new Date().toISOString(),
        });
    } else {
        const id = newAccountId || `acc_${randomUUID()}`;
        account = {
            id,
            type: 'microsoft',
            name,
            uuid: normalizedUuid,
            skinUrl: skinUrl || null,
            skinVariant: skinVariant || null,
            capeUrl: capeUrl || null,
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString(),
        };
        accounts.push(account);
        const targetDir = getAccountCacheDir(id);
        moveDir(sourceCacheDir, targetDir);
        rekeyAccountCacheDir(targetDir, id);
    }

    saveAccounts(accounts);
    return account;
}

export function removeAccountCacheDir(accountId) {
    removeDir(getAccountCacheDir(accountId));
}

export function sanitizeAccount(account) {
    return {
        id: account.id,
        type: account.type,
        name: account.name,
        uuid: account.uuid,
        createdAt: account.createdAt || null,
        skinUrl: account.skinUrl || null,
        skinVariant: account.skinVariant || null,
        capeUrl: account.capeUrl || null,
        lastLoginAt: account.lastLoginAt || null,
    };
}

export function accountCacheExists(accountId) {
    return existsSync(getAccountCacheDir(accountId));
}
