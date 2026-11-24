const path = require('path');
const defaultConfig = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

defaultConfig.resolve.alias['impers-loader$'] = path.join(path.dirname(require.resolve('impers')), 'ffi', 'loader.js');

defaultConfig.externals = [
    ({ request }, callback) => {
        if (request === 'koffi')
            return callback(null, 'commonjs koffi');
        callback();
    },
];

defaultConfig.optimization.minimize = false;

module.exports = defaultConfig;
