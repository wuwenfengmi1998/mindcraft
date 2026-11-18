const path = require('path');
const fs = require('fs-extra');
const mcAssets = require('minecraft-assets')('1.21.4');
const { makeTextureAtlas } = require('prismarine-viewer/viewer/lib/atlas');
const { prepareBlocksStates } = require('prismarine-viewer/viewer/lib/modelsBuilder');

const viewerRoot = path.dirname(require.resolve('prismarine-viewer/package.json'));
const publicDir = path.join(viewerRoot, 'public');
const texturesDir = path.join(publicDir, 'textures');
const blocksStatesDir = path.join(publicDir, 'blocksStates');

fs.ensureDirSync(texturesDir);
fs.ensureDirSync(blocksStatesDir);

const atlas = makeTextureAtlas(mcAssets);
const blocksStates = prepareBlocksStates(mcAssets, atlas);

fs.writeFileSync(path.join(texturesDir, '26.3.png'), atlas.image);
fs.writeFileSync(path.join(blocksStatesDir, '26.3.json'), JSON.stringify(blocksStates));
fs.copySync(mcAssets.directory, path.join(texturesDir, '26.3'), { overwrite: true });

console.log('Generated prismarine-viewer assets for 26.3 from 1.21.4');
console.log('textures/26.3.png:', atlas.image.length, 'bytes');
console.log('textures/26.3:', fs.readdirSync(path.join(texturesDir, '26.3')).length, 'files');
console.log('blocksStates/26.3.json:', fs.statSync(path.join(blocksStatesDir, '26.3.json')).size, 'bytes');
