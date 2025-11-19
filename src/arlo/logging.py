from __future__ import annotations

import logging
import sys

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