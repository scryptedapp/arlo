import multiprocessing
import subprocess
import threading
import time

from multiprocessing.connection import Connection
from typing import Any, IO

from .logging import TCPLogger

HEARTBEAT_INTERVAL = 5

def multiprocess_main(name: str, logger_port: int, child_conn: Connection, exe: str, args: list[str]) -> None:
    logger = TCPLogger(logger_port, 'HeartbeatChildProcess')
    try:
        logger.send(f'{name} starting\n')
        sp = subprocess.Popen([exe, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def logging_thread(stdstream: IO[bytes]) -> None:
            for line in iter(stdstream.readline, b''):
                try:
                    logger.send(line.decode('utf-8', errors='replace'))
                except Exception:
                    pass
        stdout_t = threading.Thread(target=logging_thread, args=(sp.stdout,), daemon=True)
        stderr_t = threading.Thread(target=logging_thread, args=(sp.stderr,), daemon=True)
        stdout_t.start()
        stderr_t.start()
        while True:
            has_data = child_conn.poll(HEARTBEAT_INTERVAL * 3)
            if not has_data or sp.poll() is not None:
                break
            try:
                keep_alive = child_conn.recv()
                if not keep_alive:
                    break
            except EOFError:
                break
        logger.send(f'{name} exiting\n')
        if sp.poll() is None:
            try:
                sp.terminate()
                sp.wait(timeout=5)
            except Exception:
                try:
                    sp.kill()
                except Exception:
                    pass
        stdout_t.join(timeout=2)
        stderr_t.join(timeout=2)
        logger.send(f'{name} exited\n')
    except Exception as e:
        logger.send(f'{name} error: {e}\n')
    finally:
        logger.close()

class HeartbeatChildProcess:
    def __init__(self, name: str, logger_port: int, exe: str, *args: Any) -> None:
        self.name = name
        self.logger_port = logger_port
        self.exe = exe
        self.args = args
        ctx = multiprocessing.get_context('spawn')
        self.parent_conn, self.child_conn = ctx.Pipe()
        self.process = ctx.Process(target=multiprocess_main, args=(name, logger_port, self.child_conn, exe, args))
        self.process.daemon = True
        self._stop_event = threading.Event()
        self.thread = threading.Thread(target=self.heartbeat, daemon=True)

    def start(self) -> None:
        self.process.start()
        self.thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        try:
            self.parent_conn.send(False)
        except Exception:
            pass

    def heartbeat(self) -> None:
        while not self._stop_event.is_set():
            time.sleep(HEARTBEAT_INTERVAL)
            if not self.process.is_alive():
                self.stop()
                break
            try:
                self.parent_conn.send(True)
            except Exception:
                break