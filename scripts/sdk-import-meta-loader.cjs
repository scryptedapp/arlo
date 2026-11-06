// webpack 5.109 and later bundle any file that mentions import.meta as an ES
// module. The Scrypted SDK's CommonJS build mentions it only in its ES module
// start-up branch, which a CommonJS plugin never takes, but as an ES module the
// SDK can no longer reach its own exports and fails to start. Replacing
// import.meta with undefined keeps the file CommonJS; the SDK's webpack config
// already defines import.meta as undefined for the same reason.
module.exports = function (source) {
    return source.replace(/\bimport\.meta\b/g, 'undefined');
};
