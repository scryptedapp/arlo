from __future__ import annotations

import asyncio
import logging
import socket
import sys
import threading

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import ArloDeviceBase
    from .provider import ArloProvider

class StdoutLoggerFactory:
    @staticmethod
    def get_logger(name: str, level=logging.INFO, format='[Arlo %(name)s]: %(message)s'):
        logger = logging.getLogger(name)
        if not any(isinstance(handler, logging.StreamHandler) for handler in logger.handlers):
            logger.setLevel(level)
            new_handler = logging.StreamHandler(sys.stdout)
            new_handler.setFormatter(logging.Formatter(format))
            logger.addHandler(new_handler)
        return logger

class ScryptedDeviceLoggingWrapper(logging.Handler):
    def __init__(self, scrypted_device: ArloProvider | ArloDeviceBase):
        super().__init__()
        self.scrypted_device = scrypted_device

    def emit(self, record):
        self.scrypted_device.print(self.format(record))

class ScryptedDeviceLoggerFactory:
    @staticmethod
    def get_logger(name, scrypted_device: ArloProvider | ArloDeviceBase, level=logging.INFO, format='[Arlo %(name)s]: %(message)s'):
        logger = logging.getLogger(name)
        if not any(isinstance(handler, ScryptedDeviceLoggingWrapper) for handler in logger.handlers):
            logger.setLevel(level)
            new_handler = ScryptedDeviceLoggingWrapper(scrypted_device)
            new_handler.setFormatter(logging.Formatter(format))
            logger.addHandler(new_handler)
        return logger

class ScryptedDeviceLoggerMixin:
    _logger = None
    logger_name = None

    @property
    def logger(self):
        if self._logger is None:
            self._logger = ScryptedDeviceLoggerFactory.get_logger(self.logger_name, self)
        return self._logger

class TCPLogger:
    def __init__(self, port: int, name: str, host: str = '127.0.0.1'):
        self.host = host
        self.port = port
        self.name = name
        self.sock = None
        self.lock = threading.Lock()
        self._connect()

    def _connect(self):
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=5)
            self.send(f'{self.name} connected to logging server {self.host}:{self.port}')
        except Exception as e:
            self.sock = None

    def send(self, msg: str):
        if not msg.endswith('\n'):
            msg += '\n'
        data = f'[{self.name}] {msg}'.encode('utf-8')
        with self.lock:
            if self.sock is None:
                self._connect()
            if self.sock:
                try:
                    self.sock.sendall(data)
                except Exception as e:
                    try:
                        self.sock.close()
                    except Exception:
                        pass
                    self.sock = None

    def close(self):
        with self.lock:
            if self.sock:
                try:
                    self.sock.close()
                except Exception as e:
                    pass
                self.sock = None

class TCPLogServer:
    logger_loop: asyncio.AbstractEventLoop = None
    logger_server: asyncio.AbstractServer = None
    logger_server_port: int = 0
    log_fn: function = None
    device: ArloDeviceBase

    def __init__(self, device: ArloDeviceBase, log_fn: function):
        self.device = device
        self.log_fn = log_fn
        self.logger_server = None
        self.logger_server_port = None
        self.logger_loop = asyncio.new_event_loop()
        self.device.create_task(self.create_tcp_logger_server())

    def __del__(self):
        self.close()

    async def create_tcp_logger_server(self):
        def thread_main():
            asyncio.set_event_loop(self.logger_loop)
            self.logger_loop.run_forever()
        threading.Thread(target=thread_main, daemon=True).start()

        async def callback(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
            try:
                while not reader.at_eof():
                    line = await reader.readline()
                    if not line:
                        break
                    line = str(line, 'utf-8').rstrip()
                    self.log_fn(line)
                writer.close()
                await writer.wait_closed()
            except Exception:
                self.device.logger.exception('Logger server callback raised an exception')

        async def setup():
            self.logger_server = await asyncio.start_server(callback, host='localhost', port=0, family=socket.AF_INET, flags=socket.SOCK_STREAM)
            self.logger_server_port = self.logger_server.sockets[0].getsockname()[1]
            self.device.logger.info(f'Started {self.log_fn.__name__} logging server at localhost:{self.logger_server_port}')

        self.logger_loop.call_soon_threadsafe(lambda: self.logger_loop.create_task(setup()))

    def close(self):
        def logger_exit_callback():
            if self.logger_server:
                self.logger_server.close()
            if self.logger_loop.is_running():
                self.logger_loop.stop()
            self.logger_loop.close()
        self.logger_loop.call_soon_threadsafe(logger_exit_callback)