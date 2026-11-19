import { format } from 'node:util';
import { sendAgentLog } from './mindserver_proxy.js';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_LINES_PER_SECOND = 50;

const CONSOLE_LEVELS = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
};

let installed = false;
let forwarding = false;
let windowStart = 0;
let windowCount = 0;
let droppedCount = 0;

function emitLog(agentName, level, text) {
    forwarding = true;
    try {
        sendAgentLog(agentName, level, text);
    } catch {
        // Ignore transport errors; logging must not affect the agent.
    } finally {
        forwarding = false;
    }
}

function forwardLog(agentName, level, text) {
    if (forwarding) return;

    let message = String(text ?? '');
    if (message.length > MAX_MESSAGE_LENGTH) {
        message = `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
    }

    const now = Date.now();
    if (now - windowStart >= 1000) {
        if (droppedCount > 0) {
            emitLog(agentName, 'warn', `日志输出过于频繁，已丢弃 ${droppedCount} 条`);
            droppedCount = 0;
        }
        windowStart = now;
        windowCount = 0;
    }

    if (windowCount >= MAX_LINES_PER_SECOND) {
        droppedCount++;
        return;
    }
    windowCount++;
    emitLog(agentName, level, message);
}

/**
 * Forward this process's console output to the web console log panel.
 * Installed once per agent process.
 */
export function installLogForwarder(agentName) {
    if (installed) return;
    installed = true;

    for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            if (forwarding) return;

            let text;
            try {
                text = format(...args);
            } catch {
                text = args.map(arg => String(arg)).join(' ');
            }
            forwardLog(agentName, level, text);
        };
    }
}
