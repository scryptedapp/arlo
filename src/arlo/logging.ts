export const LOG_LEVELS = ['Info', 'Debug', 'Extra Debug'];

let level = 'Info';

export function setLogLevel(value: string): void {
    level = value;
}

export function extraDebug(): boolean {
    return level === 'Extra Debug';
}

export class Logger {
    constructor(private name: string, private console: Console) {
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
