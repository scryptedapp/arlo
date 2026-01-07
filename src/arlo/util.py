import asyncio

from typing import Any


class TaskManager:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.tasks: set[asyncio.Task] = set()
        self.task_tags: dict[asyncio.Task, str | None] = {}
        self.task_owners: dict[asyncio.Task, Any] = {}
        self.loop: asyncio.AbstractEventLoop = loop

    def create_task(self, coroutine_or_awaitable, *, tag: str, owner: Any) -> asyncio.Task:
        if not tag:
            raise ValueError('tag is required and must be a non-empty string')
        if owner is None:
            raise ValueError('owner is required')
        if isinstance(coroutine_or_awaitable, asyncio.Task):
            task = coroutine_or_awaitable
            setattr(task, '_task_tag', tag)
            self.register(task, tag=tag, owner=owner)
            return task
        if asyncio.iscoroutine(coroutine_or_awaitable):
            task = self.loop.create_task(coroutine_or_awaitable)
        else:
            task = asyncio.ensure_future(coroutine_or_awaitable)
        setattr(task, '_task_tag', tag)
        self.register(task, tag=tag, owner=owner)
        return task

    def register(self, task: asyncio.Task, tag: str, owner: Any) -> None:
        if task is None:
            return
        if not tag:
            raise ValueError('tag is required and must be a non-empty string')
        if owner is None:
            raise ValueError('owner is required')
        self.tasks.add(task)
        self.task_tags[task] = tag
        self.task_owners[task] = owner

        def _on_done(t: asyncio.Task) -> None:
            self.tasks.discard(t)
            self.task_tags.pop(t, None)
            self.task_owners.pop(t, None)

        task.add_done_callback(_on_done)

    def cancel_by_tag(self, tag: str, owner: Any = None) -> None:
        for t, tg in list(self.task_tags.items()):
            if tg == tag and not t.done() and (owner is None or self.task_owners.get(t) == owner):
                t.cancel()

    async def cancel_and_await_by_tag(self, tag: str, owner: Any = None) -> None:
        tasks = [t for t, tg in list(self.task_tags.items()) if tg == tag and (owner is None or self.task_owners.get(t) == owner)]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_by_owner(self, owner: Any) -> None:
        for t, o in list(self.task_owners.items()):
            if o == owner and not t.done():
                t.cancel()

    async def cancel_and_await_by_owner(self, owner: Any) -> None:
        tasks = [t for t, o in list(self.task_owners.items()) if o == owner]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_all_except(self, tag: str | None = None, owner: Any = None) -> None:
        for t in list(self.tasks):
            t_tag = self.task_tags.get(t)
            t_owner = self.task_owners.get(t)
            if owner is not None and t_owner != owner:
                continue
            if tag is not None and t_tag == tag:
                continue
            if not t.done():
                t.cancel()

    async def cancel_and_await_all_except(self, tag: str | None = None, owner: Any = None) -> None:
        tasks = [t for t in list(self.tasks) if (owner is None or self.task_owners.get(t) == owner) and not (tag is not None and self.task_tags.get(t) == tag)]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_all(self) -> None:
        for t in list(self.tasks):
            if not t.done():
                t.cancel()

    async def cancel_and_await_all(self) -> None:
        tasks = list(self.tasks)
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def list_tasks(self) -> list[tuple[asyncio.Task, str | None, Any]]:
        return [(t, self.task_tags.get(t), self.task_owners.get(t)) for t in list(self.tasks)]


class UnauthorizedRestartException(Exception):
    """Raised when a 401 Unauthorized is encountered and a plugin restart is needed."""
    pass


class RequestError(Exception):
    """Base error for request-related failures."""
    pass


class InvalidResponseError(RequestError):
    """Response could not be parsed or was invalid for expected schema."""
    pass


class BadRequestError(RequestError):
    """HTTP 4xx non-auth client errors that should not trigger restart."""
    pass