const minecraftProtocol = require('minecraft-protocol');
const minecraftData = require('minecraft-data');
const mineflayer = require('mineflayer/package.json');
const protocol = require('minecraft-protocol/package.json');
const data = require('minecraft-data/package.json');
const chunk = require('prismarine-chunk/package.json');
const physics = require('prismarine-physics/package.json');

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

console.log('mineflayer:', mineflayer.version);
console.log('minecraft-protocol:', protocol.version);
console.log('minecraft-data:', data.version);
console.log('prismarine-chunk:', chunk.version);
console.log('prismarine-physics:', physics.version);
console.log('supported versions:', minecraftProtocol.supportedVersions.slice(-5).join(', '));
console.log('minecraft-data 26.3:', data263 ? 'OK' : 'FAILED');

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`ERROR: ${failure}`);
    }
    process.exit(1);
}

console.log('Minecraft 26.3 依赖与数据验证通过');
