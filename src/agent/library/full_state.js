import { 
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";
import convoManager from '../conversation.js';

const MAX_TASK_GOAL_LENGTH = 4000;
const taskGoalCache = new WeakMap();

function truncateText(value, maxLength) {
    if (value === null || value === undefined) return null;
    const text = String(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}…`;
}

function getTaskState(agent) {
    const task = agent.task;
    const selfPrompter = agent.self_prompter;
    let selfPromptState = 'stopped';
    if (selfPrompter?.isActive()) selfPromptState = 'active';
    else if (selfPrompter?.isPaused()) selfPromptState = 'paused';

    const taskState = {
        hasTask: !!(task && task.data),
        selfPrompt: truncateText(selfPrompter?.prompt, MAX_TASK_GOAL_LENGTH),
        selfPromptState,
        npcGoals: [],
        npcCurrentGoal: null,
    };

    if (task?.data) {
        let goal = null;
        try {
            if (taskGoalCache.has(task)) {
                goal = taskGoalCache.get(task);
            } else {
                goal = task.getAgentGoal();
                taskGoalCache.set(task, goal);
            }
        } catch (err) {
            console.warn('Failed to read task goal:', err.message || err);
        }
        const startTime = Number(task.taskStartTime);
        taskState.id = task.data.task_id || null;
        taskState.type = task.data.type || null;
        taskState.goal = truncateText(goal, MAX_TASK_GOAL_LENGTH);
        const timeout = Number(task.data.timeout);
        taskState.timeoutSeconds = Number.isFinite(timeout) && timeout > 0 ? timeout : 300;
        taskState.elapsedSeconds = Number.isFinite(startTime)
            ? Math.max(0, Math.round((Date.now() - startTime) / 1000))
            : 0;
        taskState.agentCount = Number.isFinite(Number(task.data.agent_count)) ? Number(task.data.agent_count) : 1;
        taskState.humanCount = Number.isFinite(Number(task.data.human_count)) ? Number(task.data.human_count) : 0;
    }

    const npcData = agent.npc?.data;
    if (npcData) {
        if (Array.isArray(npcData.goals)) {
            taskState.npcGoals = npcData.goals.map(goal => ({
                name: goal.name,
                quantity: Number.isFinite(Number(goal.quantity)) ? Number(goal.quantity) : 1,
            }));
        }
        if (npcData.curr_goal) {
            taskState.npcCurrentGoal = {
                name: npcData.curr_goal.name,
                quantity: Number.isFinite(Number(npcData.curr_goal.quantity)) ? Number(npcData.curr_goal.quantity) : 1,
            };
        }
    }

    return taskState;
}

export function getFullState(agent) {
    const bot = agent.bot;
    let taskState = null;
    try {
        taskState = getTaskState(agent);
    } catch (err) {
        console.warn('Failed to read task state:', err.message || err);
    }

    const pos = getPosition(bot);
    const position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    const below = getBlockAtPosition(bot, 0, -1, 0).name;
    const legs = getBlockAtPosition(bot, 0, 0, 0).name;
    const head = getBlockAtPosition(bot, 0, 1, 0).name;

    let players = getNearbyPlayerNames(bot);
    let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
    players = players.filter(p => !bots.includes(p));

    const helmet = bot.inventory.slots[5];
    const chestplate = bot.inventory.slots[6];
    const leggings = bot.inventory.slots[7];
    const boots = bot.inventory.slots[8];

    // Richer activity than a bare "Idle": a bot counts as idle (no action executing) even while
    // chatting, deciding its next move, or stopped. Surface those so the dashboard is meaningful.
    let activity;
    if (!agent.isIdle()) {
        activity = { current: agent.actions.currentActionLabel || 'Acting', kind: 'acting' };
    } else if (convoManager.inConversation()) {
        const who = convoManager.activeConversation?.name;
        activity = { current: who ? `Chatting with ${who}` : 'Chatting', kind: 'chatting' };
    } else if (agent.self_prompter.isStopped()) {
        activity = { current: 'Stopped', kind: 'stopped' };   // self-prompter OFF: won't act on its own
    } else if (agent.self_prompter.isPaused()) {
        activity = { current: 'Chatting', kind: 'chatting' };
    } else if (agent.self_prompter.isActive()) {
        activity = { current: 'Thinking', kind: 'thinking' }; // self-prompting between actions
    } else {
        activity = { current: 'Idle', kind: 'idle' };
    }

    const state = {
        name: agent.name,
        gameplay: {
            position,
            dimension: bot.game.dimension,
            gamemode: bot.game.gameMode,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            biome: getBiomeName(bot),
            weather,
            timeOfDay: bot.time.timeOfDay,
            timeLabel
        },
        action: {
            current: activity.current,
            kind: activity.kind,
            isIdle: agent.isIdle()
        },
        task: taskState,
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: getFirstBlockAboveHead(bot, null, 32)
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: bots,
            entityTypes: getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item'),
        },
        modes: {
            summary: bot.modes.getMiniDocs()
        }
    };

    return state;
}