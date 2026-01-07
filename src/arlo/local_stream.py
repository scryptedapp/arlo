from __future__ import annotations

import asyncio
import os
import ssl
import tempfile
import traceback

from typing import TYPE_CHECKING

from .util import TaskManager as _LocalTaskManager

if TYPE_CHECKING:
    from .provider import ArloProvider
    from .basestation import ArloBasestation
    from .camera import ArloCamera


class RTSPMessage:
    HEADER_NORMALIZATION = {
        'cseq': 'CSeq',
        'rtp-info': 'RTP-Info',
    }

    def __init__(self, raw: bytes):
        self.raw = raw
        self.first_line = ''
        self.headers = []
        self.body = b''
        self._parse()

    def _parse(self):
        try:
            parts = self.raw.split(b'\r\n\r\n', 1)
            header_lines = parts[0].split(b'\r\n')
            if header_lines:
                self.first_line = header_lines[0].decode(errors='ignore')
            for line in header_lines[1:]:
                if b':' in line:
                    key, value = line.split(b':', 1)
                    self.headers.append(
                        (self._normalize_header(key.strip().decode()), value.strip().decode())
                    )
            if len(parts) > 1:
                self.body = parts[1]
        except Exception as e:
            self.first_line = ''
            self.headers = []
            self.body = b''
            raise RuntimeError(f'RTSPMessage parse error: {e}')

    def _normalize_header(self, name: str) -> str:
        return self.HEADER_NORMALIZATION.get(name.lower(), name)

    def formatted(self) -> str:
        lines = [self.first_line]
        for k, v in self.headers:
            lines.append(f'{k}: {v}')
        if self.body:
            lines.append('')
            lines.append(self.body.decode(errors='ignore'))
        return '\n'.join(lines)

    def to_bytes(self) -> bytes:
        lines = [self.first_line.encode()]
        for k, v in self.headers:
            lines.append(f'{k}: {v}'.encode())
        result = b'\r\n'.join(lines) + b'\r\n\r\n'
        if self.body:
            result += self.body
        return result

    def get_header(self, name: str) -> str | None:
        name_lower = name.lower()
        for k, v in self.headers:
            if str(k).lower() == name_lower:
                return v
        return None

    def set_header(self, name: str, value: str):
        normalized = self._normalize_header(name)
        name_lower = name.lower()
        for i, (k, _) in enumerate(self.headers):
            if str(k).lower() == name_lower:
                self.headers[i] = (normalized, value)
                return
        self.headers.append((normalized, value))


class ArloLocalStreamProxy:
    def __init__(self, provider: ArloProvider, basestation: ArloBasestation, camera: ArloCamera):
        self.provider = provider
        self.task_manager = self.provider.task_manager
        self.basestation = basestation
        self.camera = camera
        self.logger = camera.logger
        self.listener = None
        self.listener_port = None
        self.extra_debug_logging = str(self.provider.storage.getItem('extra_debug_logging')).lower() == 'true'
        self.certfile = self._write_temp_file(self.basestation.peer_cert, 'cert.pem')
        self.keyfile = self._write_temp_file(self.provider.arlo_private_key, 'key.pem')
        self.ssl_context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
        self.ssl_context.check_hostname = False
        self.ssl_context.verify_mode = ssl.CERT_NONE
        self.ssl_context.load_cert_chain(self.certfile, self.keyfile)
        self.nonce = 0

    async def start(self) -> int:
        self.listener = await asyncio.start_server(self._handle_connection, '127.0.0.1', 0)
        self.listener_port = self.listener.sockets[0].getsockname()[1]
        self.logger.debug(f'ArloLocalStreamProxy listening on 127.0.0.1:{self.listener_port}')
        return self.listener_port

    async def _handle_connection(
        self, rebroadcast_reader: asyncio.StreamReader, rebroadcast_writer: asyncio.StreamWriter
    ):
        self.nonce = 0
        basestation_reader = basestation_writer = None
        try:
            self.logger.debug(f'Connecting to basestation {self.basestation.ip}:554')
            basestation_reader, basestation_writer = await asyncio.open_connection(
                self.basestation.ip, 554, ssl=self.ssl_context
            )

            async def _connection_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, from_rebroadcast: bool):
                direction = 'Rebroadcast → Basestation' if from_rebroadcast else 'Basestation → Rebroadcast'
                try:
                    while True:
                        data = await reader.read(4096)
                        if not data:
                            if self.extra_debug_logging:
                                self.logger.debug(f'End of Stream received, closing connection handler ({direction})')
                            break
                        is_interleaved = self._is_interleaved(data)
                        is_rtsp = self._is_rtsp(data)
                        rtsp_msg = None
                        try:
                            if is_interleaved:
                                if self.extra_debug_logging:
                                    self.logger.debug(f'Video/Audio Stream Data: {len(data)} bytes ({direction})')
                                await self._write_and_drain(writer, data)
                                await asyncio.sleep(0.005)
                            elif is_rtsp:
                                try:
                                    rtsp_msg = RTSPMessage(data)
                                    if from_rebroadcast:
                                        self._handle_outgoing_nonce_and_urls(rtsp_msg)
                                    else:
                                        self._handle_incoming_nonce_and_urls(rtsp_msg)
                                    if self.extra_debug_logging:
                                        self.logger.debug(
                                            f'{"Outgoing" if from_rebroadcast else "Incoming"} RTSP message:\n{rtsp_msg.formatted()}'
                                        )
                                    await self._write_and_drain(writer, rtsp_msg.to_bytes())
                                except Exception as e:
                                    self.logger.error(f'RTSP parsing error in {direction}: {e}. Forwarding raw.')
                                    self.logger.error(traceback.format_exc())
                                    await self._write_and_drain(writer, data)
                            else:
                                await self._write_and_drain(writer, data)
                        except Exception as e:
                            self.logger.error(f'Error in {direction}: {e}')
                            self.logger.error(traceback.format_exc())
                            await self._write_and_drain(writer, data)
                except asyncio.CancelledError:
                    pass
                except ssl.SSLError as e:
                    if e.reason != 'APPLICATION_DATA_AFTER_CLOSE_NOTIFY':
                        raise
                    else:
                        pass
                finally:
                    try:
                        await self._silent_close(writer)
                    except Exception:
                        pass

            connection_handlers = [
                self.task_manager.create_task(_connection_handler(rebroadcast_reader, basestation_writer, True), tag=f'local_stream:{self.camera.arlo_device["deviceId"]}', owner=self),
                self.task_manager.create_task(_connection_handler(basestation_reader, rebroadcast_writer, False), tag=f'local_stream:{self.camera.arlo_device["deviceId"]}', owner=self),
            ]
            _, pending = await asyncio.wait(connection_handlers, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                try:
                    await asyncio.wait_for(task, timeout=1)
                except Exception:
                    pass
        except Exception as e:
            self.logger.error(f'Proxy connection error: {e}')
            self.logger.error(traceback.format_exc())
        finally:
            await self._cleanup_connections(basestation_writer, rebroadcast_writer)

    async def _silent_close(self, writer: asyncio.StreamWriter):
        if writer and not writer.is_closing():
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), timeout=1)
            except Exception:
                pass

    async def _write_and_drain(self, writer: asyncio.StreamWriter, data: bytes):
        writer.write(data)
        await writer.drain()

    def _handle_outgoing_nonce_and_urls(self, msg: RTSPMessage) -> None:
        if self.nonce != 0:
            self.nonce += 1
            msg.set_header('Nonce', str(self.nonce))
        if 'rtsp://' in msg.first_line:
            msg.first_line = msg.first_line.replace(f'localhost:{self.listener_port}', self.basestation.host_name)
        for k, v in msg.headers:
            if 'rtsp://' in v:
                msg.set_header(k, str(v).replace(f'localhost:{self.listener_port}', self.basestation.host_name))

    def _handle_incoming_nonce_and_urls(self, msg: RTSPMessage) -> None:
        new_nonce = msg.get_header('Nonce')
        if new_nonce:
            try:
                self.nonce = int(new_nonce)
            except Exception as e:
                self.logger.error(f'Error parsing nonce "{new_nonce}": {e}')
        if 'rtsp://' in msg.first_line:
            msg.first_line = msg.first_line.replace(self.basestation.host_name, f'localhost:{self.listener_port}')
        for k, v in msg.headers:
            if 'rtsp://' in v:
                msg.set_header(k, str(v).replace(self.basestation.host_name, f'localhost:{self.listener_port}'))

    def _is_rtsp(self, data: bytes) -> bool:
        rtsp_methods = (
            b'RTSP/', b'OPTIONS', b'DESCRIBE', b'SETUP', b'PLAY', b'TEARDOWN',
            b'GET_PARAMETER', b'SET_PARAMETER', b'ANNOUNCE', b'RECORD', b'PAUSE'
        )
        return any(data.startswith(method) for method in rtsp_methods)

    def _is_interleaved(self, data: bytes) -> bool:
        return len(data) > 0 and data[0] == 0x24

    async def _cleanup_connections(self, *writers: asyncio.StreamWriter):
        for writer in writers:
            await self._silent_close(writer)
        if self.listener:
            self.listener.close()
            try:
                await self.listener.wait_closed()
            except Exception:
                pass
            self.listener = None
        for f in (self.certfile, self.keyfile):
            if f and os.path.exists(f):
                try:
                    os.remove(f)
                except Exception as e:
                    self.logger.warning(f'Failed to delete temp file {f}: {e}')

    def _write_temp_file(self, content: str, filename: str) -> str:
        with tempfile.NamedTemporaryFile('w', delete=False, suffix=filename) as f:
            f.write(content)
            return f.name