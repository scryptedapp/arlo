import makeMdns from 'multicast-dns';

import type { Logger } from '../logging';
import { sleep } from '../util';

const SERVICE = '_arlo-video._tcp.local';

export interface ArloService {
    server: string;
    address: string;
    deviceId: string;
}

function txtValue(data: unknown, key: string): string | undefined {
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
        const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
        const separator = text.indexOf('=');
        if (separator > 0 && text.slice(0, separator).toLowerCase() === key)
            return text.slice(separator + 1);
    }
    return undefined;
}

export async function browseArloServices(logger: Logger, duration = 2_000): Promise<Record<string, ArloService>> {
    const mdns = makeMdns();
    const instances = new Set<string>();
    const targets = new Map<string, string>();
    const deviceIds = new Map<string, string>();
    const addresses = new Map<string, string>();
    mdns.on('error', e => logger.debug(`mDNS error: ${e}`));
    mdns.on('warning', e => logger.debug(`mDNS warning: ${e}`));
    try {
        mdns.on('response', response => {
            for (const answer of [...response.answers, ...response.additionals]) {
                switch (answer.type) {
                    case 'PTR':
                        if (answer.name === SERVICE && !instances.has(answer.data)) {
                            instances.add(answer.data);
                            mdns.query([{ name: answer.data, type: 'SRV' }, { name: answer.data, type: 'TXT' }]);
                        }
                        break;
                    case 'SRV':
                        targets.set(answer.name, answer.data.target);
                        if (!addresses.has(answer.data.target))
                            mdns.query(answer.data.target, 'A');
                        break;
                    case 'TXT': {
                        const deviceId = txtValue(answer.data, 'deviceid');
                        if (deviceId)
                            deviceIds.set(answer.name, deviceId);
                        break;
                    }
                    case 'A':
                        addresses.set(answer.name, answer.data);
                        break;
                    case 'AAAA':
                        if (!addresses.has(answer.name))
                            addresses.set(answer.name, answer.data);
                        break;
                }
            }
        });
        mdns.query(SERVICE, 'PTR');
        await sleep(duration);
    }
    catch (e) {
        logger.error('Error browsing mDNS:', e);
    }
    finally {
        mdns.destroy();
    }
    const services: Record<string, ArloService> = {};
    for (const instance of instances) {
        const server = targets.get(instance);
        const deviceId = deviceIds.get(instance);
        const address = server && addresses.get(server);
        if (!server || !deviceId || !address)
            continue;
        services[deviceId] = { server, address, deviceId };
        logger.debug(`Service added: ${JSON.stringify(services[deviceId])}`);
    }
    return services;
}
