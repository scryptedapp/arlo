// impers' library loader (impers/dist/ffi/loader.js), which webpack.nodejs.config.js
// makes importable; impers itself exports only its main module.
declare module 'impers-loader' {
    export const LIBCURL_IMPERSONATE_VERSION: string;
    export function resolveLibrary(): Promise<{ path: string, isImpersonate: boolean }>;
}
