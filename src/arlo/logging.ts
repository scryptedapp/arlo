export const LOG_LEVELS = ['Info', 'Debug', 'Extra Debug'] as const;

export type LogLevel = typeof LOG_LEVELS[number];

// One level for the whole plugin, set from the provider's Logging Level setting.
let level: LogLevel = 'Info';

export function setLogLevel(value: LogLevel): void {
    level = value;
}

export function getLogLevel(): LogLevel {
    return level;
}

// Extra Debug adds full Arlo Cloud requests, responses and stream traffic to
// the Debug output.
export function extraDebug(): boolean {
    return level === 'Extra Debug';
}

// Writes "[name]: message" to a Scrypted console: a device's own console for
// devices, the plugin console for the provider and the Arlo Cloud client.
export class Logger {
    constructor(private readonly name: string, private readonly console: Console) {
    }

    debug(message: string, ...details: unknown[]): void {
        if (level !== 'Info')
            this.console.log(this.format(message), ...details);
    }

    info(message: string, ...details: unknown[]): void {
        this.console.log(this.format(message), ...details);
    }

    warn(message: string, ...details: unknown[]): void {
        this.console.warn(this.format(message), ...details);
    }

    error(message: string, ...details: unknown[]): void {
        this.console.error(this.format(message), ...details);
    }

    private format(message: string): string {
        return `[${this.name}]: ${message}`;
    }
}
