const path = require('path');
const defaultConfig = require(process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG);

// koffi is impers' dependency, not ours, so resolve it from impers.
const koffi = require.resolve('koffi', {
    paths: [path.dirname(require.resolve('impers'))],
});

// koffi's ES module build locates itself through import.meta, which the
// default config removes, so bundle its CommonJS build instead.
defaultConfig.resolve.alias['koffi$'] = koffi;

// koffi loads its native code from per-platform packages (@koromix/koffi-*).
// scripts/koffi-binaries.mjs places them in fs/koffi, which the plugin zip
// carries next to the bundle, so require them from there at runtime.
defaultConfig.externals = [
    ({ request }, callback) => {
        if (/^@koromix\/koffi-/.test(request))
            return callback(null, `commonjs ./fs/koffi/${request}`);
        callback();
    },
];

module.exports = defaultConfig;
