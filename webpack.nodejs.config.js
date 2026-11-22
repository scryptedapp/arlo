const path = require('path');
const defaultConfig = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

// impers' library loader, which the plugin calls to check a downloaded
// libcurl-impersonate before impers loads it. impers exports only its main
// module, so it is reached by path.
defaultConfig.resolve.alias['impers-loader$'] = path.join(path.dirname(require.resolve('impers')), 'ffi', 'loader.js');

// koffi carries native binaries, which a bundle cannot, so it is left out:
// Scrypted installs the version package.json pins under optionalDependencies
// on the server, and the plugin requires it from there. The SDK's own handling
// of optionalDependencies does not serve impers, an ES module importing it.
defaultConfig.externals = [
    ({ request }, callback) => {
        if (request === 'koffi')
            return callback(null, 'commonjs koffi');
        callback();
    },
];

// The published build is not minified, which would save only about 5% of the
// zip: it is then the build that was tested, and logs keep readable names.
defaultConfig.optimization.minimize = false;

module.exports = defaultConfig;
