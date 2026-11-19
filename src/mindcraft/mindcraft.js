import { createMindServer, registerAgent, numStateListeners, getAgentSettings } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import open from 'open';

let mindserver;
let connected = false;
let agent_processes = {};
let agent_indices = {};
let agent_count = 0;
let mindserver_port = 8080;
let manual_start = false;
const startTokens = new Map();

export async function init(host_public=false, port=8080, auto_open_ui=true, manualStart=false) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    manual_start = manualStart;
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                open('http://localhost:'+port);
            }
        }, 3000);
    }
}

export async function createAgent(settings) {
    if (!settings.profile.name) {
        console.error('机器人配置中必须包含名称');
        return {
            success: false,
            error: '机器人配置中必须包含名称'
        };
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    agent_indices[agent_name] = agentIndex;
    registerAgent(settings);

    if (manual_start) {
        return {
            success: true,
            error: null,
            pending: true
        };
    }

    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;

    try {
        try {
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version;
        } catch (error) {
            console.warn(`Error getting server:`, error);
            if (settings.minecraft_version === "auto") {
                settings.minecraft_version = null;
            }
            console.warn(`Attempting to connect anyway...`);
        }

        const agentProcess = new AgentProcess(agent_name, mindserver_port);
        agentProcess.start(load_memory, init_message, agentIndex);
        agent_processes[agent_name] = agentProcess;
    } catch (error) {
        console.error(`创建机器人 ${agent_name} 时出错:`, error);
        destroyAgent(agent_name);
        return {
            success: false,
            error: error.message
        };
    }
    return {
        success: true,
        error: null
    };
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function isManualStart() {
    return manual_start;
}

export async function startAgent(agentName) {
    const token = {};
    startTokens.set(agentName, token);
    const isCancelled = () => startTokens.get(agentName) !== token;

    const existingProcess = agent_processes[agentName];
    if (existingProcess?.running) {
        startTokens.delete(agentName);
        existingProcess.forceRestart();
        return { success: true, error: null };
    }
    if (existingProcess) {
        delete agent_processes[agentName];
    }

    const agentSettings = getAgentSettings(agentName);
    if (!agentSettings) {
        startTokens.delete(agentName);
        console.error(`Cannot start agent ${agentName}; not found`);
        return { success: false, error: `未找到机器人“${agentName}”` };
    }

    try {
        const server = await getServer(agentSettings.host, agentSettings.port, agentSettings.minecraft_version);
        if (isCancelled()) {
            return { success: false, cancelled: true, error: '连接已取消' };
        }
        agentSettings.host = server.host;
        agentSettings.port = server.port;
        agentSettings.minecraft_version = server.version;
    } catch (error) {
        if (isCancelled()) {
            return { success: false, cancelled: true, error: '连接已取消' };
        }
        console.error(`Cannot start agent ${agentName}:`, error.message);
        startTokens.delete(agentName);
        return { success: false, error: `无法连接 Minecraft 服务端：${error.message}` };
    }

    if (isCancelled()) {
        return { success: false, cancelled: true, error: '连接已取消' };
    }

    const agentIndex = agent_indices[agentName] ?? 0;
    const agentProcess = new AgentProcess(agentName, mindserver_port);
    try {
        agentProcess.start(agentSettings.load_memory || false, agentSettings.init_message || null, agentIndex);
        agent_processes[agentName] = agentProcess;
    } catch (error) {
        startTokens.delete(agentName);
        return { success: false, error: error.message };
    }
    startTokens.delete(agentName);
    return { success: true, error: null };
}

export function cancelAgentStart(agentName) {
    const hadPendingStart = startTokens.delete(agentName);
    const process = agent_processes[agentName];
    if (process) {
        process.cancel();
    }
    return { success: true, cancelled: hadPendingStart || !!process };
}

export function stopAgent(agentName) {
    startTokens.delete(agentName);
    if (agent_processes[agentName]) {
        agent_processes[agentName].cancel();
    }
}

export function destroyAgent(agentName) {
    startTokens.delete(agentName);
    if (agent_processes[agentName]) {
        agent_processes[agentName].cancel();
        delete agent_processes[agentName];
    }
}

export function shutdown() {
    console.log('Shutting down');
    for (let agentName in agent_processes) {
        agent_processes[agentName].stop();
    }
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}
