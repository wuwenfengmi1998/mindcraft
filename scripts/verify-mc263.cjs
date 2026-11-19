const fs = require('fs');
const path = require('path');
const minecraftProtocol = require('minecraft-protocol');
const minecraftData = require('minecraft-data');
const mineflayer = require('mineflayer/package.json');
const protocol = require('minecraft-protocol/package.json');
const data = require('minecraft-data/package.json');
const chunk = require('prismarine-chunk/package.json');
const physics = require('prismarine-physics/package.json');
const { getVersion } = require('prismarine-viewer/viewer/lib/version');
const minecraftDatatypes = require('minecraft-protocol/src/datatypes/minecraft');

const failures = [];

if (!minecraftProtocol.supportedVersions.includes('26.3')) {
    failures.push(`minecraft-protocol 不支持 26.3，当前最高版本：${minecraftProtocol.supportedVersions.at(-1)}`);
}

let data263 = null;
try {
    data263 = minecraftData('26.3');
} catch (err) {
    failures.push(`minecraft-data 无法加载 26.3：${err.message}`);
}

if (data263 && data263.version?.minecraftVersion !== '26.3') {
    failures.push(`minecraft-data 26.3 版本信息异常：${JSON.stringify(data263.version)}`);
}

const mineflayerDir = path.dirname(require.resolve('mineflayer/package.json'));
const resolvedProtocol = require.resolve('minecraft-protocol/package.json', { paths: [mineflayerDir] });
const topLevelProtocol = require.resolve('minecraft-protocol/package.json');
if (resolvedProtocol !== topLevelProtocol) {
    failures.push(`mineflayer 仍在使用嵌套 protocol：${resolvedProtocol}`);
}

if (!minecraftDatatypes.entityDelta) {
    failures.push('minecraft-protocol 缺少 entityDelta 原生类型');
}

if (getVersion('26.3') !== '26.3') {
    failures.push(`prismarine-viewer 不支持 26.3：${getVersion('26.3')}`);
}

const itemRoot = path.dirname(require.resolve('prismarine-item/package.json'));
const itemSource = fs.readFileSync(path.join(itemRoot, 'index.js'), 'utf8');
if (!itemSource.includes('1.20.5+ data components')) {
    failures.push('prismarine-item 缺少 26.3 附魔兼容补丁（执行 npx patch-package）');
}

const viewerRoot = path.dirname(require.resolve('prismarine-viewer/package.json'));
for (const file of [
    'public/textures/26.3.png',
    'public/textures/26.3',
    'public/blocksStates/26.3.json'
]) {
    const target = path.join(viewerRoot, file);
    if (!fs.existsSync(target)) failures.push(`prismarine-viewer 缺少资源：${file}`);
}

for (const file of ['public/index.js', 'public/worker.js']) {
    const target = path.join(viewerRoot, file);
    if (!fs.existsSync(target)) {
        failures.push(`prismarine-viewer 缺少 bundle：${file}`);
        continue;
    }
    const content = fs.readFileSync(target, 'utf8');
    if (!content.includes('26.3')) {
        failures.push(`prismarine-viewer bundle 未包含 26.3：${file}`);
    }
}

console.log('mineflayer:', mineflayer.version);
console.log('minecraft-protocol:', protocol.version);
console.log('minecraft-data:', data.version);
console.log('prismarine-chunk:', chunk.version);
console.log('prismarine-physics:', physics.version);
console.log('supported versions:', minecraftProtocol.supportedVersions.slice(-5).join(', '));
console.log('minecraft-data 26.3:', data263 ? 'OK' : 'FAILED');
console.log('protocol resolution:', resolvedProtocol === topLevelProtocol ? 'top-level' : resolvedProtocol);
console.log('entityDelta:', minecraftDatatypes.entityDelta ? 'OK' : 'missing');
console.log('viewer version:', getVersion('26.3'));

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`ERROR: ${failure}`);
    }
    process.exit(1);
}

console.log('Minecraft 26.3 依赖、数据与查看器验证通过');
