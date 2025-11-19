import asyncio
import contextlib
import logging


class BackgroundTaskMixin:
    background_tasks: set[asyncio.Task]
    logger: logging.Logger

    def create_task(self, coroutine, tag=None) -> asyncio.Task:
        task = asyncio.get_event_loop().create_task(coroutine)
        if tag:
            setattr(task, '_task_tag', tag)
        self.register_task(task)
        return task

    def register_task(self, task: asyncio.Task) -> None:
        if not hasattr(self, 'background_tasks'):
            self.background_tasks = set()
        assert task is not None

        def print_exception(task: asyncio.Task):
            try:
                exc = task.exception()
            except asyncio.CancelledError:
                return
            if exc:
                self.logger.error(f'task exception: {task.exception()}')

        self.background_tasks.add(task)
        task.add_done_callback(print_exception)
        task.add_done_callback(self.background_tasks.discard)

    def cancel_task(self, task: asyncio.Task) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        if task in self.background_tasks:
            task.cancel()
            self.background_tasks.discard(task)

    def cancel_pending_tasks(self, tag: str | None = None) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        for task in list(self.background_tasks):
            task_tag = getattr(task, '_task_tag', None)
            if tag is not None and task_tag == tag:
                continue
            task.cancel()
            self.background_tasks.discard(task)

    def cancel_tasks_by_tag(self, tag: str) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        for task in list(self.background_tasks):
            if getattr(task, '_task_tag', None) == tag:
                task.cancel()
                self.background_tasks.discard(task)

    async def cancel_and_await_tasks_by_tag(self, tag: str) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        for task in list(self.background_tasks):
            if getattr(task, '_task_tag', None) == tag:
                if not task.done():
                    task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                self.background_tasks.discard(task)

class UnauthorizedRestartException(Exception):
    """Raised when a 401 Unauthorized is encountered and a plugin restart is needed."""
    pass


class RequestError(Exception):
    """Base error for request-related failures."""
    pass


class TransientNetworkError(RequestError):
    """Network or server transient error (retry suggested)."""
    pass


class RateLimitError(RequestError):
    """HTTP 429 Too Many Requests encountered."""
    pass


class InvalidResponseError(RequestError):
    """Response could not be parsed or was invalid for expected schema."""
    pass


class BadRequestError(RequestError):
    """HTTP 4xx non-auth client errors that should not trigger restart."""
    pass