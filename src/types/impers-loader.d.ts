declare module 'impers-loader' {
    export const LIBCURL_IMPERSONATE_VERSION: string;
    export function resolveLibrary(): Promise<{ path: string, isImpersonate: boolean }>;
}
