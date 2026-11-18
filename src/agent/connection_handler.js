import { sendOutputToServer } from './mindserver_proxy.js';

// Definitions of error types, keywords, and full human-readable messages.
const ERROR_DEFINITIONS = {
    'name_conflict': {
        keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'],
        msg: 'Name Conflict: The name is already in use or you are already logged in.',
        isFatal: true
    },
    'access_denied': {
        keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'],
        msg: 'Access Denied: You are not whitelisted or banned.',
        isFatal: true
    },
    'server_full': {
        keywords: ['server is full', 'full server'],
        msg: 'Connection Failed: The server is full.',
        isFatal: false
    },
    'version_mismatch': {
        keywords: ['outdated', 'version', 'client'],
        msg: 'Version Mismatch: Client and server versions do not match.',
        isFatal: true
    },
    'maintenance': {
        keywords: ['maintenance', 'updating', 'closed', 'restarting'],
        msg: 'Connection Failed: Server is under maintenance or restarting.',
        isFatal: false
    },
    'network_error': {
        keywords: ['timeout', 'timed out', 'connection lost', 'reset', 'refused', 'keepalive'],
        msg: 'Network Error: Connection timed out or was lost.',
        isFatal: false
    },
    'behavior': {
        keywords: ['flying', 'spam', 'speed'],
        msg: 'Kicked: Removed from server due to flying, spamming, or invalid movement.',
        isFatal: true
    },
    'invalid_movement': {
        keywords: ['invalid_player_movement', 'invalid player movement', 'invalid move player packet', '非法玩家移动'],
        msg: 'Kicked: Server rejected an invalid player movement packet.',
        isFatal: true
    }
};

function stringifyReason(reason) {
    if (!reason) return '';
    if (typeof reason === 'string') return reason;
    if (typeof reason.toString === 'function') {
        try {
            const text = reason.toString();
            if (text && text !== '[object Object]') return text;
        } catch (_) {}
    }
    try {
        return JSON.stringify(reason);
    } catch (_) {
        return String(reason);
    }
}

// Helper to log messages to console (once) and MindServer.
export const log = (agentName, msg) => {
    // Use console.error for visibility in terminal
    console.error(msg);
    try { sendOutputToServer(agentName || 'system', msg); } catch (_) {}
};

// Analyzes the kick reason and returns a full, human-readable sentence.
export function parseKickReason(reason) {
    if (!reason) return { type: 'unknown', msg: 'Unknown reason (Empty)', isFatal: true };
    
    const reasonText = stringifyReason(reason);
    const raw = reasonText.toLowerCase();

    // Search for keywords in definitions
    for (const [type, def] of Object.entries(ERROR_DEFINITIONS)) {
        if (def.keywords.some(k => raw.includes(k))) {
            console.error(`Disconnected: ${reasonText}`);
            return { type, msg: def.msg, isFatal: def.isFatal };
        }
    }
    
    // Fallback: extract readable text from the ChatMessage object
    let fallback = reasonText;
    try {
        const obj = typeof reason === 'string' ? JSON.parse(reason) : reason;
        const extracted = obj.translate || obj.text || obj.value?.translate || obj.value?.text;
        if (extracted) fallback = stringifyReason(extracted);
        if (typeof fallback === 'object') fallback = JSON.stringify(fallback);
    } catch (_) {}
    
    return { type: 'other', msg: `Disconnected: ${fallback}`, isFatal: true };
}

// Centralized handler for disconnections.
export function handleDisconnection(agentName, reason) {
    const { type, msg } = parseKickReason(reason);
    
    // Format: [LoginGuard] Error Message
    const finalMsg = `[LoginGuard] ${msg}`;
    
    // Only call log once (it handles console printing)
    log(agentName, finalMsg);
    
    return { type, msg: finalMsg };
}

// Validates name format.
export function validateNameFormat(name) {
    if (!name || !/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        return { 
            success: false, 
            // Added [LoginGuard] prefix here for consistency
            msg: `[LoginGuard] Invalid name '${name}'. Must be 3-16 alphanumeric/underscore characters.` 
        };
    }
    return { success: true };
}