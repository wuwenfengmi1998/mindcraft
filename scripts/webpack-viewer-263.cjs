const path = require('path');

const configs = require('../node_modules/prismarine-viewer/webpack.config.js');
const threeCjs = require.resolve('three/build/three.js');

for (const config of configs) {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
        ...(config.resolve.alias || {}),
        three$: path.resolve(threeCjs)
    };
    config.module = config.module || {};
    config.module.rules = [
        ...(config.module.rules || []),
        {
            test: /[\\/]three[\\/]examples[\\/]js[\\/]controls[\\/]OrbitControls\.js$/,
            sideEffects: true
        }
    ];
}

module.exports = configs;
