import { randomUUID } from 'crypto';
import { mkdirSync, rmSync, readdirSync } from 'fs';
import path from 'path';
import prismarineAuth from 'prismarine-auth';
import {
    getAccount,
    getAccountCacheDir,
    getAuthCacheRoot,
    loadAccounts,
    rekeyAccountCacheDir,
    sanitizeAccount,
    upsertMicrosoftAccount,
} from '../utils/accounts.js';

const { Authflow, Titles } = prismarineAuth;

const FLOW_TTL_MS = 10 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 2 * 60 * 1000;
const START_TIMEOUT_MS = 30000;

const flows = new Map();

// Migrate old cache file names keyed by login flow IDs, and remove orphaned
// cache folders left behind by failed or interrupted logins.
try {
    const cacheRoot = getAuthCacheRoot();
    const microsoftAccounts = loadAccounts().filter(account => account.type === 'microsoft');
    const accountIds = new Set(microsoftAccounts.map(account => account.id));
    for (const account of microsoftAccounts) {
        rekeyAccountCacheDir(getAccountCacheDir(account.id), account.id);
    }
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('pending-')) {
            rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
        } else if (entry.name.startsWith('acc_') && !accountIds.has(entry.name)) {
            rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
        }
    }
} catch { /* auth-cache does not exist yet */ }

function cleanupFlows() {
    const now = Date.now();
    for (const [flowId, flow] of flows) {
        if (flow.expiresAt > now) continue;
        flows.delete(flowId);
        if (flow.pendingCacheDir) {
            try {
                rmSync(flow.pendingCacheDir, { recursive: true, force: true });
            } catch (err) {
                console.warn('Failed to clean pending auth cache:', err.message);
            }
        }
    }
}

function flowResponse(flow) {
    return {
        flowId: flow.id,
        accountId: flow.accountId,
        status: flow.status,
        userCode: flow.codeInfo?.userCode || null,
        verificationUri: flow.codeInfo?.verificationUri || null,
        message: flow.codeInfo?.message || null,
        expiresIn: flow.codeInfo?.expiresIn || null,
        interval: flow.codeInfo?.interval || null,
        account: flow.account || null,
        error: flow.error || null,
    };
}

function normalizeCode(code) {
    return {
        userCode: code.user_code,
        verificationUri: code.verification_uri || 'https://microsoft.com/link',
        message: code.message || '',
        expiresIn: code.expires_in || null,
        interval: code.interval || 5,
    };
}

function removePendingDir(flow) {
    if (!flow.pendingCacheDir) return;
    try {
        rmSync(flow.pendingCacheDir, { recursive: true, force: true });
    } catch (err) {
        console.warn('Failed to clean pending auth cache:', err.message);
    }
    flow.pendingCacheDir = null;
}

function friendlyAuthError(err) {
    const message = String(err?.message || err || 'Microsoft 登录失败');
    if (message.includes('403 Forbidden')) {
        return 'Microsoft/Xbox 拒绝了登录请求（403）。请确认该账号已创建 Xbox 档案、没有家长控制限制，并稍后重试。';
    }
    if (message.includes('404') || message.includes('Not Found')) {
        return '未能获取 Minecraft 档案，请确认该 Microsoft 账号拥有 Minecraft Java Edition。';
    }
    if (message.includes('invalid_grant')) {
        return 'Microsoft 授权已过期或失效，请重新登录。';
    }
    return message;
}

export async function startMicrosoftLogin(accountId = null) {
    cleanupFlows();

    const existing = accountId ? getAccount(accountId) : null;
    if (accountId && (!existing || existing.type !== 'microsoft')) {
        throw new Error('在线账号不存在');
    }

    for (const flow of flows.values()) {
        if (flow.accountId === accountId && flow.status !== 'success' && flow.status !== 'error') {
            return flowResponse(flow);
        }
    }

    const flowId = `flow_${randomUUID()}`;
    const cacheOwnerId = accountId || `acc_${randomUUID()}`;
    const cacheDir = getAccountCacheDir(cacheOwnerId);
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

    const flow = {
        id: flowId,
        accountId: accountId || null,
        cacheOwnerId,
        status: 'starting',
        codeInfo: null,
        account: null,
        error: null,
        cancelled: false,
        pendingCacheDir: accountId ? null : cacheDir,
        createdAt: Date.now(),
        expiresAt: Date.now() + FLOW_TTL_MS,
        resolveCode: null,
    };
    flows.set(flowId, flow);

    const codePromise = new Promise(resolve => {
        flow.resolveCode = resolve;
    });

    const authflow = new Authflow(
        cacheOwnerId,
        cacheDir,
        {
            flow: 'live',
            // Use prismarine-auth/mineflayer's default title. The MinecraftJava
            // title combined with the live flow currently gets a 403 from Xbox.
            authTitle: Titles.MinecraftNintendoSwitch,
            deviceType: 'Nintendo',
            ...(accountId ? { forceRefresh: true } : {}),
        },
        code => {
            if (flow.cancelled) return;
            flow.codeInfo = normalizeCode(code);
            flow.status = 'waiting';
            flow.expiresAt = Date.now() + Math.max(60000, (flow.codeInfo.expiresIn || 900) * 1000) + 60000;
            flow.resolveCode?.(flow.codeInfo);
        }
    );
    flow.authflow = authflow;

    flow.authPromise = authflow.getMinecraftJavaToken({ fetchProfile: true })
        .then(result => {
            if (flow.cancelled) return flow;
            const profile = result?.profile;
            if (!profile?.id || !profile?.name) {
                throw new Error('该账号未获取到 Minecraft 资料，请确认已购买 Minecraft Java Edition');
            }
            const skin = Array.isArray(profile.skins) && profile.skins.length > 0 ? profile.skins[0] : null;
            const cape = Array.isArray(profile.capes) && profile.capes.length > 0 ? profile.capes[0] : null;
            const account = upsertMicrosoftAccount({
                existingId: accountId,
                newAccountId: accountId ? undefined : cacheOwnerId,
                uuid: profile.id,
                name: profile.name,
                skinUrl: skin?.url || null,
                skinVariant: skin?.variant || null,
                capeUrl: cape?.url || null,
                sourceCacheDir: cacheDir,
            });
            flow.status = 'success';
            flow.account = sanitizeAccount(account);
            flow.pendingCacheDir = null;
            flow.expiresAt = Date.now() + COMPLETED_FLOW_TTL_MS;
            return flow;
        })
        .catch(err => {
            if (flow.cancelled) return flow;
            console.error('Microsoft login failed:', err);
            flow.status = 'error';
            flow.error = friendlyAuthError(err);
            flow.expiresAt = Date.now() + COMPLETED_FLOW_TTL_MS;
            removePendingDir(flow);
            return flow;
        });

    const outcome = await Promise.race([
        codePromise.then(() => 'code'),
        flow.authPromise.then(() => 'done'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), START_TIMEOUT_MS)),
    ]);

    if (outcome === 'done') {
        return flowResponse(flow);
    }
    if (outcome === 'timeout' && flow.status === 'starting') {
        return flowResponse(flow);
    }
    return flowResponse(flow);
}

export function getMicrosoftLoginStatus(flowId) {
    cleanupFlows();
    const flow = flows.get(flowId);
    if (!flow) return null;
    return flowResponse(flow);
}

export function cancelMicrosoftLogin(flowId) {
    cleanupFlows();
    const flow = flows.get(flowId);
    if (!flow) return null;
    if (flow.status !== 'success') {
        flow.cancelled = true;
        flow.status = 'error';
        flow.error = '登录已取消';
        flow.expiresAt = Date.now() + COMPLETED_FLOW_TTL_MS;
    }
    return flowResponse(flow);
}
