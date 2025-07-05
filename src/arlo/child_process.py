import asyncio
import multiprocessing
import queue
import subprocess
import threading
import time

from multiprocessing.connection import Connection
from typing import Any

from .logging import TCPLogger

HEARTBEAT_INTERVAL = 5

def multiprocess_main(
    name: str,
    logger_port: int,
    child_conn: Connection,
    exe: str,
    args: list[str],
    buffer_queue: multiprocessing.Queue
) -> None:
    logger = TCPLogger(logger_port, 'HeartbeatChildProcess')
    try:
        logger.send(f'{name} child process starting\n')
        sp = subprocess.Popen([exe, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stop_event = threading.Event()

        def stdout_thread():
            temp_buffer = b''
            found_start = False
            while not stop_event.is_set():
                chunk = sp.stdout.read(4096)
                if not chunk:
                    break
                temp_buffer += chunk
                if not found_start:
                    start = temp_buffer.find(b'\xFF\xD8')
                    if start != -1:
                        found_start = True
                        temp_buffer = temp_buffer[start:]
                if found_start:
                    end = temp_buffer.find(b'\xFF\xD9')
                    if end != -1:
                        end += 2
                        frame = temp_buffer[:end]
                        buffer_queue.put(frame, block=True, timeout=HEARTBEAT_INTERVAL * 3)
                        break

        def stderr_thread():
            for line in iter(sp.stderr.readline, b''):
                try:
                    logger.send(line.decode('utf-8', errors='replace'))
                except Exception:
                    pass

        t_out = threading.Thread(target=stdout_thread, daemon=True)
        t_err = threading.Thread(target=stderr_thread, daemon=True)
        t_out.start()
        t_err.start()
        logger.send(f'{name} child process started\n')
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
        logger.send(f'{name} child process exiting\n')
        if sp.poll() is None:
            try:
                sp.terminate()
                sp.wait(timeout=5)
            except Exception:
                try:
                    sp.kill()
                except Exception:
                    pass
        stop_event.set()
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        logger.send(f'{name} child process exited\n')
    except Exception as e:
        logger.send(f'{name} error: {e}\n')
    finally:
        logger.close()

class HeartbeatChildProcess:
    def __init__(self, name: str, logger_port: int, exe: str, *args: Any) -> None:
        self.name = name
        self.logger_port = logger_port
        self.exe = exe
        self.args = list(args)
        ctx = multiprocessing.get_context('spawn')
        self.parent_conn, self.child_conn = ctx.Pipe()
        self.buffer_queue = ctx.Queue()
        self.process = ctx.Process(
            target=multiprocess_main,
            args=(name, logger_port, self.child_conn, exe, self.args, self.buffer_queue)
        )
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
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join()
        self.parent_conn.close()
        self.child_conn.close()
        self.buffer_queue.close()
        self.buffer_queue.join_thread()

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

    async def buffer(self) -> bytes:
        loop = asyncio.get_event_loop()
        self.start()
        try:
            frame = await loop.run_in_executor(
                None, self.buffer_queue.get, True, HEARTBEAT_INTERVAL * 6
            )
            return frame
        except queue.Empty:
            return b''
        finally:
            self.stop()