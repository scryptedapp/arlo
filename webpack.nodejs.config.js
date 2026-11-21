const path = require('path');
const defaultConfig = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

// Keep the Scrypted SDK's CommonJS build CommonJS; see the loader for why.
defaultConfig.module.rules.push({
    test: /[\\/]@scrypted[\\/]sdk[\\/]dist[\\/]src[\\/]index\.js$/,
    loader: path.resolve(__dirname, 'scripts/sdk-import-meta-loader.cjs'),
    enforce: 'pre',
});

// impers' library loader, which the plugin calls to check a downloaded
// libcurl-impersonate before impers loads it. impers exports only its main
// module, so it is reached by path.
defaultConfig.resolve.alias['impers-loader$'] = path.join(path.dirname(require.resolve('impers')), 'ffi', 'loader.js');

// koffi carries native binaries, which a bundle cannot, so it is left out:
// Scrypted installs the version package.json pins under optionalDependencies
// on the server, and the plugin requires it from there.
defaultConfig.externals = [
    ({ request }, callback) => {
        if (request === 'koffi')
            return callback(null, 'commonjs koffi');
        callback();
    },
];

// The published build is minified. Class names stay, since error names in
// logs come from them, and license comments stay in the bundle, since the
// zip carries only the bundle.
const TerserPlugin = require('terser-webpack-plugin');
defaultConfig.optimization.minimizer = [
    new TerserPlugin({
        extractComments: false,
        terserOptions: {
            compress: { typeofs: false },
            keep_classnames: true,
        },
    }),
];

module.exports = defaultConfig;
