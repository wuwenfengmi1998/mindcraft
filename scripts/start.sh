#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PROFILE="${MINDCRAFT_PROFILE:-./profiles/deepseek-ollama.json}"
WAIT_SECONDS="${MINDCRAFT_WAIT_SECONDS:-120}"
UI_URL="http://localhost:8080"

info() {
    echo "[mindcraft] $*"
}

fail() {
    echo "[mindcraft] 错误：$*" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "未找到 node，请先安装 Node.js"
command -v npm >/dev/null 2>&1 || fail "未找到 npm"
[ -d node_modules ] || fail "缺少 node_modules，请先执行：npm install && npm run setup:mc263"
[ -f "$PROFILE" ] || fail "profile 不存在：$PROFILE"

info "检查 26.3 依赖..."
if ! npm run --silent verify:mc263 >/tmp/mindcraft-verify.log 2>&1; then
    cat /tmp/mindcraft-verify.log >&2
    fail "26.3 依赖未就绪，请执行：npm run setup:mc263"
fi

info "检查 API Key..."
node - "$PROFILE" <<'NODE'
const fs = require('fs');
const profilePath = process.argv[2];
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
let keys = {};
try {
    keys = JSON.parse(fs.readFileSync('keys.json', 'utf8'));
} catch {}

const keyMap = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    xai: 'XAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    qwen: 'QWEN_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQCLOUD_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    hyperbolic: 'HYPERBOLIC_API_KEY',
    novita: 'NOVITA_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    mercury: 'MERCURY_API_KEY',
    replicate: 'REPLICATE_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY'
};

function apiFor(model) {
    if (!model) return null;
    if (typeof model === 'object') return model.api || null;
    const name = String(model);
    for (const api of Object.keys(keyMap)) {
        if (name.startsWith(api + '/')) return api;
    }
    if (/gpt|o1|o3/.test(name)) return 'openai';
    if (name.includes('claude')) return 'anthropic';
    if (name.includes('gemini')) return 'google';
    if (name.includes('deepseek')) return 'deepseek';
    if (name.includes('qwen')) return 'qwen';
    if (name.includes('mistral')) return 'mistral';
    if (name.includes('grok')) return 'xai';
    return null;
}

const required = new Set();
for (const model of [profile.model, profile.code_model, profile.vision_model, profile.embedding]) {
    const api = apiFor(model);
    if (api && keyMap[api]) required.add(keyMap[api]);
}

const missing = [...required].filter((name) => !(keys[name] || process.env[name]));
if (missing.length > 0) {
    console.error(`缺少 API Key：${missing.join(', ')}`);
    console.error('请写入 keys.json 或设置环境变量。');
    process.exit(1);
}
NODE

EMBED_MODEL="$(node - "$PROFILE" <<'NODE'
const fs = require('fs');
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const embedding = profile.embedding;
if (typeof embedding === 'string' && embedding.startsWith('ollama')) {
    console.log(embedding.split('/')[1] || 'embeddinggemma');
} else if (embedding && typeof embedding === 'object' && embedding.api === 'ollama') {
    console.log(embedding.model || 'embeddinggemma');
}
NODE
)"

if [ -n "$EMBED_MODEL" ]; then
    info "检查 Ollama embedding 模型：$EMBED_MODEL"
    nc -z 127.0.0.1 11434 2>/dev/null || fail "Ollama 未运行，请打开 Ollama 或执行：ollama serve"
    node - "$EMBED_MODEL" <<'NODE'
const model = process.argv[2];
fetch('http://127.0.0.1:11434/api/tags')
    .then((res) => res.json())
    .then((data) => {
        const models = (data.models || []).map((item) => item.name);
        const found = models.some((name) => name === model || name.startsWith(model + ':'));
        if (!found) {
            console.error(`缺少 Ollama 模型 ${model}，请执行：ollama pull ${model}`);
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error(`无法连接 Ollama：${err.message}`);
        process.exit(1);
    });
NODE
fi

if nc -z 127.0.0.1 8080 2>/dev/null; then
    info "MindServer 已在运行：$UI_URL"
    if command -v open >/dev/null 2>&1; then open "$UI_URL"; fi
    exit 0
fi

if ! nc -z 127.0.0.1 55916 2>/dev/null; then
    echo "[mindcraft] 未检测到 Minecraft 世界（127.0.0.1:55916）。"
    echo "[mindcraft] 请在 HMCL 中启动 Minecraft 26.3 世界，然后："
    echo "             Esc -> 对局域网开放 -> 端口 55916 -> 开始"
    if [ "$WAIT_SECONDS" -gt 0 ]; then
        echo "[mindcraft] 等待端口 55916，最长 ${WAIT_SECONDS} 秒..."
        for ((i = 0; i < WAIT_SECONDS; i++)); do
            if nc -z 127.0.0.1 55916 2>/dev/null; then break; fi
            if [ $((i % 10)) -eq 0 ] && [ "$i" -gt 0 ]; then
                echo "[mindcraft] 仍在等待 55916... ${i}s"
            fi
            sleep 1
        done
    fi
fi
nc -z 127.0.0.1 55916 2>/dev/null || fail "端口 55916 未开放"

AGENT_NAME="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(p.name || 'agent');" "$PROFILE")"

export PROFILES="$(node -e "process.stdout.write(JSON.stringify([process.argv[1]]));" "$PROFILE")"
if [ "${MINDCRAFT_VISION:-1}" = "1" ]; then
    export SETTINGS_JSON="$(node -e "let s={}; try { s = process.env.SETTINGS_JSON ? JSON.parse(process.env.SETTINGS_JSON) : {}; } catch {} s.allow_vision = true; s.render_bot_view = true; process.stdout.write(JSON.stringify(s));")"
fi

info "启动机器人：$AGENT_NAME"
info "控制台：$UI_URL"
info "按 Ctrl+C 停止"

node main.js &
MAIN_PID=$!

cleanup() {
    kill "$MAIN_PID" 2>/dev/null || true
    pkill -f "init_agent.js ${AGENT_NAME}" 2>/dev/null || true
}

trap 'cleanup; exit 130' INT TERM

set +e
wait "$MAIN_PID"
STATUS=$?
set -e

cleanup
exit "$STATUS"
