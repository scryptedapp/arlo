import asyncio
import logging

from typing import Any
from zeroconf import ServiceStateChange, Zeroconf
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf


class ArloAsyncListener:
    def __init__(self, logger: logging.Logger) -> None:
        self.logger: logging.Logger = logger
        self.services: dict[str, dict[str, Any]] = {}

    def async_on_service_state_change(self, zeroconf: Zeroconf, service_type: str, name: str, state_change: ServiceStateChange) -> None:
        if state_change is not ServiceStateChange.Added:
            return
        asyncio.ensure_future(self.async_write_service_info(zeroconf, service_type, name))

    async def async_write_service_info(self, zeroconf: Zeroconf, service_type: str, name: str) -> None:
        info = AsyncServiceInfo(service_type, name)
        await info.async_request(zeroconf, 1000)
        if info:
            addresses = [addr for addr in info.parsed_scoped_addresses()]
            item = {
                'server': info.server[:-1],
                'address': addresses[0],
                'deviceId': info.properties[b'deviceid'].decode('utf-8')
            }
            self.services[item['deviceId']] = item
            self.logger.debug(f'Service added: {item}')


class ArloAsyncBrowser:
    def __init__(self, logger: logging.Logger) -> None:
        self.logger: logging.Logger = logger
        self.aiobrowser: AsyncServiceBrowser | None = None
        self.aiozc: AsyncZeroconf | None = None
        self.aiolistener: ArloAsyncListener | None = None
        self.services: dict[str, dict[str, Any]] = {}
        self.logger.debug('AsyncBrowser opened')

    async def async_run(self) -> None:
        try:
            self.aiozc = AsyncZeroconf()
            self.aiolistener = ArloAsyncListener(self.logger)
            services = ['_arlo-video._tcp.local.']
            self.aiobrowser = AsyncServiceBrowser(self.aiozc.zeroconf, services, handlers=[self.aiolistener.async_on_service_state_change])
            await asyncio.sleep(1)
            self.services = self.aiolistener.services
        except Exception as e:
            self.logger.error(f'Error running AsyncBrowser: {e}')
        finally:
            await self.async_close()

    async def async_close(self) -> None:
        if self.aiobrowser:
            await self.aiobrowser.async_cancel()
        if self.aiozc:
            await self.aiozc.async_close()
        self.logger.debug('AsyncBrowser closed')