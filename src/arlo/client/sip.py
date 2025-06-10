import asyncio
import collections
import hashlib
import logging
import random
import re
import websockets

from typing import Any

SIP_DIGEST = 'Digest'
SIP_MD5 = 'MD5'

def _rand_string(n: int, chars: str = 'abcdefghijklmnopqrstuvwxyz0123456789') -> str:
    return ''.join(random.choice(chars) for _ in range(n))

def _rand_digits(n: int) -> str:
    return _rand_string(n, '0123456789')

def _gen_branch() -> str:
    return 'z9hG4bK' + _rand_digits(7)

def _md5_digest(*args) -> str:
    s = ':'.join(args)
    return hashlib.md5(s.encode()).hexdigest()

class SIPMessage:
    def __init__(self, raw: str | None = None):
        self.method: str | None = None
        self.status_code: int | None = None
        self.reason: str | None = None
        self.uri: str | None = None
        self.headers: dict[str, list[str]] = collections.defaultdict(list)
        self.body: str = ''
        if raw:
            self.parse(raw)

    def __repr__(self):
        return f'<SIPMessage method={self.method} status_code={self.status_code} uri={self.uri}>'

    def parse(self, raw: str):
        try:
            lines = raw.split('\r\n')
            first = lines[0]
            if first.startswith('SIP/2.0'):
                m = re.match(r'SIP/2.0 (\d+) (.+)', first)
                if m:
                    self.status_code = int(m.group(1))
                    self.reason = m.group(2)
            else:
                m = re.match(r'(\w+) (.+) SIP/2.0', first)
                if m:
                    self.method = m.group(1)
                    self.uri = m.group(2)
            idx = 1
            while idx < len(lines):
                line = lines[idx]
                if line == '':
                    idx += 1
                    break
                if ':' in line:
                    k, v = line.split(':', 1)
                    k = k.strip().lower()
                    v = v.strip()
                    self.headers[k].append(v)
                idx += 1
            self.body = '\r\n'.join(lines[idx:])
        except Exception as e:
            logging.getLogger(__name__).error(f"Error parsing SIP message: {e}", exc_info=True)
            raise

    def get_header(self, name: str) -> str | None:
        vals = self.headers.get(name.lower())
        return vals[0] if vals else None

    def get_headers(self, name: str) -> list[str]:
        return self.headers.get(name.lower(), [])

    def set_header(self, name: str, value: str):
        self.headers[name.lower()] = [value]

    def add_header(self, name: str, value: str):
        self.headers[name.lower()].append(value)

    def build(self) -> str:
        try:
            if self.method:
                start = f'{self.method} {self.uri} SIP/2.0'
            else:
                start = f'SIP/2.0 {self.status_code} {self.reason}'
            lines = [start]
            for k, vals in self.headers.items():
                for v in vals:
                    lines.append(f'{k}: {v}')
            lines.append('')
            if self.body:
                lines.append(self.body)
            return '\r\n'.join(lines)
        except Exception as e:
            logging.getLogger(__name__).error(f"Error building SIP message: {e}", exc_info=True)
            raise

class AuthHeader:
    def __init__(self, mode: str, params: list[str, str]):
        self.mode = mode
        self.params = params

    def update_response_digest(self, method: str, password: str):
        """
        Update the response digest for Digest authentication.
        """
        if self.params.get('algorithm') != SIP_MD5:
            raise Exception(f'cannot compute response digest with algorithm {self.params.get("algorithm")!r}')
        if self.params.get('qop') != 'auth':
            raise Exception(f'cannot compute response digest with qop {self.params.get("qop")!r}')
        for k in ['username', 'realm', 'uri', 'nonce', 'cnonce', 'nc']:
            if k not in self.params:
                raise Exception(f'missing {k} in auth header')
        ha1 = _md5_digest(self.params['username'], self.params['realm'], password)
        ha2 = _md5_digest(method, self.params['uri'])
        response = _md5_digest(ha1, self.params['nonce'], self.params['nc'], self.params['cnonce'], self.params['qop'], ha2)
        self.params['response'] = response

    def __str__(self):
        params = []
        for k, v in self.params.items():
            if k in ('algorithm', 'qop', 'nc'):
                params.append(f'{k}={v}')
            else:
                params.append(f'{k}="{v}"')
        return f'{self.mode} {", ".join(params)}'

    @staticmethod
    def parse(header: str) -> 'AuthHeader':
        if not header.startswith(SIP_DIGEST):
            raise Exception('unsupported header mode, expected "Digest"')
        kvs = header[len(SIP_DIGEST):].split(',')
        params = {}
        for kv in kvs:
            kv = kv.strip()
            tokens = kv.split('=', 1)
            if len(tokens) < 2:
                raise Exception(f'could not parse header param {kv}')
            k, v = tokens[0], tokens[1]
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1]
            params[k] = v
        if params.get('algorithm') != SIP_MD5:
            raise Exception(f'unsupported auth digest {params.get("algorithm")}')
        return AuthHeader(SIP_DIGEST, params)

class SIPManager:
    def __init__(self, logger: logging.Logger, sip_cfg: dict[str, Any]):
        self.logger = logger
        self.sip_cfg = sip_cfg
        self.keepalive_task: asyncio.Task | None = None
        self.rand_host = _rand_string(12) + '.invalid'
        self.timeout = 5
        self.ws = None
        self.invite_resp: SIPMessage | None = None
        self.invite_resp_lock = asyncio.Lock()
        self.call_id: str | None = None
        self.cseq: int | None = None
        self.branch: str | None = None
        self.tag: str | None = None
        self.to_tag: str | None = None
        self.route_set: list[str] = []

    async def connect_websocket(self):
        self.logger.debug(f'Connecting to SIP websocket at {self.sip_cfg["WebsocketURI"]}')
        self.ws = await websockets.connect(
            self.sip_cfg['WebsocketURI'],
            user_agent_header=self.sip_cfg['WebsocketHeaders'],
            origin=self.sip_cfg['WebsocketOrigin'],
            subprotocols=['sip'],
            ping_interval=None,
        )
        self.logger.debug('SIP websocket connected.')

    def build_invite(self, local_sdp: str, auth: str | None = None) -> SIPMessage:
        self.logger.debug('Building SIP INVITE message.')
        self.call_id = self.call_id or _rand_string(16)
        self.cseq = self.cseq or 1
        self.branch = self.branch or _gen_branch()
        self.tag = self.tag or _rand_string(8)
        msg = SIPMessage()
        msg.method = 'INVITE'
        msg.uri = self.sip_cfg['CalleeURI']
        msg.set_header('Via', f'SIP/2.0/WSS {self.rand_host};branch={self.branch}')
        msg.set_header('Max-Forwards', '70')
        msg.set_header('To', f'<{self.sip_cfg["CalleeURI"]}>')
        msg.set_header('From', f'<{self.sip_cfg["CallerURI"]}>;tag={self.tag}')
        msg.set_header('Call-ID', self.call_id)
        msg.set_header('CSeq', f'{self.cseq} INVITE')
        msg.set_header('Contact', f'<sip:{self.sip_cfg["CallerURI"].split(":")[1].split("@")[0]}@{self.rand_host};transport=ws>')
        msg.set_header('User-Agent', self.sip_cfg.get('UserAgent', 'PythonSIP/1.0'))
        msg.set_header('Supported', 'outbound')
        msg.set_header('Content-Type', 'application/sdp')
        msg.set_header('Content-Length', str(len(local_sdp)))
        if auth:
            msg.set_header('Proxy-Authorization', auth)
        msg.body = local_sdp
        self.logger.debug(f'SIP INVITE message built:\n{msg.build()}')
        return msg

    def build_ack(self) -> SIPMessage:
        self.logger.debug('Building SIP ACK message.')
        msg = SIPMessage()
        msg.method = 'ACK'
        msg.uri = self.sip_cfg['CalleeURI']
        msg.set_header('Via', f'SIP/2.0/WSS {self.rand_host};branch={_gen_branch()}')
        msg.set_header('Max-Forwards', '70')
        to = f'<{self.sip_cfg["CalleeURI"]}>'
        if self.to_tag:
            to += f';tag={self.to_tag}'
        msg.set_header('To', to)
        msg.set_header('From', f'<{self.sip_cfg["CallerURI"]}>;tag={self.tag}')
        msg.set_header('Call-ID', self.call_id)
        msg.set_header('CSeq', f'{self.cseq} ACK')
        msg.set_header('Contact', f'<sip:{self.sip_cfg["CallerURI"].split(":")[1].split("@")[0]}@{self.rand_host};transport=ws>')
        msg.set_header('User-Agent', self.sip_cfg.get('UserAgent', 'PythonSIP/1.0'))
        msg.set_header('Supported', 'outbound')
        msg.set_header('Content-Length', '0')
        for rr in self.route_set:
            msg.add_header('Record-Route', rr)
        self.logger.debug(f'SIP ACK message built:\n{msg.build()}')
        return msg

    def build_bye(self) -> SIPMessage:
        self.logger.debug('Building SIP BYE message.')
        msg = self.build_ack()
        msg.method = 'BYE'
        msg.set_header('CSeq', f'{self.cseq + 1} BYE')
        self.logger.debug(f'SIP BYE message built:\n{msg.build()}')
        return msg

    def build_message(self, payload: str) -> SIPMessage:
        self.logger.debug(f'Building SIP MESSAGE with payload: {payload!r}')
        msg = SIPMessage()
        msg.method = 'MESSAGE'
        msg.uri = self.sip_cfg['CalleeURI']
        msg.set_header('Via', f'SIP/2.0/WSS {self.rand_host};branch={_gen_branch()}')
        msg.set_header('Max-Forwards', '70')
        msg.set_header('To', f'<{self.sip_cfg["CalleeURI"]}>')
        msg.set_header('From', f'<{self.sip_cfg["CallerURI"]}>;tag={_rand_string(8)}')
        msg.set_header('Call-ID', _rand_string(16))
        msg.set_header('CSeq', '1 MESSAGE')
        caller_user = str(self.sip_cfg['CallerURI']).split(':')[1].split('@')[0]
        msg.set_header('Contact', f'<sip:{caller_user}@{self.rand_host};transport=ws>')
        msg.set_header('User-Agent', self.sip_cfg.get('UserAgent', 'PythonSIP/1.0'))
        msg.set_header('Supported', 'outbound')
        msg.set_header('Content-Type', 'text/plain')
        msg.set_header('Content-Length', str(len(payload)))
        msg.body = payload
        self.logger.debug(f'SIP MESSAGE built:\n{msg.build()}')
        return msg

    async def write_websocket(self, msg: SIPMessage):
        msg_str = msg.build().replace('WebRTC-UDP', '"WebRTC-UDP"')
        self.logger.debug(f'Sending SIP message:\n{msg_str}')
        await self.ws.send(msg_str)

    async def read_websocket(self) -> SIPMessage:
        self.logger.debug('Waiting for SIP response from websocket...')
        msg = await asyncio.wait_for(self.ws.recv(), timeout=self.timeout)
        self.logger.debug(f'Got SIP response:\n{msg}')
        return SIPMessage(msg)

    async def send_ack(self):
        self.logger.debug('Sending SIP ACK.')
        ack = self.build_ack()
        await self.write_websocket(ack)

    async def start(self) -> str:
        self.logger.debug('Starting SIPManager session.')
        await self.connect_websocket()
        try:
            local_sdp = self.sip_cfg.get('SDP')
            self.call_id = _rand_string(16)
            self.cseq = 1
            self.branch = _gen_branch()
            self.tag = _rand_string(8)
            invite = self.build_invite(local_sdp)
            await self.write_websocket(invite)
            trying = await self.read_websocket()
            if trying.status_code != 100:
                self.logger.error(f'Expected 100 Trying, got {trying.status_code}')
                raise Exception('Did not receive 100 Trying')
            resp = await self.read_websocket()
            status = resp.status_code
            if status == 407:
                self.logger.debug('Received 407 Proxy Authentication Required.')
                proxy_auth = resp.get_header('Proxy-Authenticate')
                self.logger.debug(f'Proxy-Authenticate header: {proxy_auth}')
                auth_header = AuthHeader.parse(proxy_auth)
                auth_header.params['username'] = str(self.sip_cfg['CallerURI']).split(':')[1].split('@')[0]
                auth_header.params['uri'] = self.sip_cfg['CalleeURI']
                auth_header.params['cnonce'] = _rand_string(12)
                auth_header.params['nc'] = '00000001'
                auth_header.update_response_digest('INVITE', self.sip_cfg['Password'])
                self.cseq += 1
                self.branch = _gen_branch()
                invite = self.build_invite(local_sdp, str(auth_header))
                await self.send_ack()
                await self.write_websocket(invite)
                trying = await self.read_websocket()
                if trying.status_code != 100:
                    self.logger.error(f'Expected 100 Trying after auth, got {trying.status_code}')
                    raise Exception('Did not receive 100 Trying after auth')
                resp = await self.read_websocket()
                status = resp.status_code
            if status != 200:
                self.logger.error(f'Expected 200 OK, got {status}')
                raise Exception(f'Did not receive 200 OK, got {status}')
            to_header = resp.get_header('To')
            if to_header and 'tag=' in to_header:
                self.to_tag = to_header.split('tag=')[-1].split(';')[0]
            self.route_set = resp.get_headers('Record-Route')
            answer_sdp = resp.body
            self.logger.debug(f'Received remote SDP:\n{answer_sdp}')
            await self.send_ack()
            async with self.invite_resp_lock:
                self.invite_resp = resp
            self.logger.debug('SIPManager session started successfully.')
            return answer_sdp
        except Exception as e:
            self.logger.exception(f'Exception in SIPManager.start: {e}')
            await self.close()
            raise

    async def keepalive_loop(self):
        self.logger.debug('Starting SIP keepalive loop.')
        try:
            while True:
                await asyncio.sleep(30)
                msg = self.build_message('keepAlive')
                await self.write_websocket(msg)
                resp = await self.read_websocket()
                if resp.status_code not in (200, 202):
                    self.logger.warning(f'Did not receive 200 OK or 202 Accepted for keepAlive, got {resp.status_code}')
                    break
        except Exception as e:
            self.logger.error(f"Error in keepalive loop: {e}", exc_info=True)

    async def close(self):
        self.logger.debug('Closing SIPManager session.')
        try:
            if self.keepalive_task:
                self.logger.debug('Cancelling keepalive loop.')
                self.keepalive_task.cancel()
                try:
                    await self.keepalive_task
                except asyncio.CancelledError:
                    self.logger.debug('Keepalive loop cancelled.')
                self.keepalive_task = None
            async with self.invite_resp_lock:
                if self.invite_resp:
                    bye = self.build_bye()
                    try:
                        await self.write_websocket(bye)
                        self.logger.debug('Sent BYE message.')
                    except Exception as e:
                        self.logger.warning(f'Exception sending BYE: {e}')
            if self.ws:
                await self.ws.close()
                self.logger.debug('Websocket closed.')
        except Exception as e:
            self.logger.error(f"Error closing SIPManager: {e}", exc_info=True)
            raise

    async def auto_start_talk(self):
        self.logger.debug('Auto starting talk.')
        try:
            await self.start_talk()
            self.keepalive_task = asyncio.create_task(self.keepalive_loop())
        except Exception as e:
            self.logger.error(f"Error in auto_start_talk: {e}", exc_info=True)
            raise

    async def start_talk(self):
        payload = f'deviceId:{self.sip_cfg["DeviceID"]};startTalk'
        self.logger.debug(f'Sending startTalk message: {payload!r}')
        msg = self.build_message(payload)
        await self.write_websocket(msg)
        resp = await self.read_websocket()
        if resp.status_code not in (200, 202):
            raise Exception(f'Did not receive 200 OK or 202 Accepted for startTalk, got {resp.status_code}')
        self.logger.debug('startTalk accepted.')

    async def stop_talk(self):
        payload = f'deviceId:{self.sip_cfg["DeviceID"]};stopTalk'
        self.logger.debug(f'Sending stopTalk message: {payload!r}')
        msg = self.build_message(payload)
        await self.write_websocket(msg)
        resp = await self.read_websocket()
        if resp.status_code not in (200, 202):
            raise Exception(f'Did not receive 200 OK or 202 Accepted for stopTalk, got {resp.status_code}')
        self.logger.debug('stopTalk accepted.')