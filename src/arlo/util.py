import asyncio
import contextlib
import logging
from typing import Optional, Union, List

class BackgroundTaskMixin:
    background_tasks: set[asyncio.Task]
    logger: logging.Logger

    def create_task(self, coroutine, tag: Optional[str] = None) -> asyncio.Task:
        """
        Create and register a background task with an optional tag.
        
        Args:
            coroutine: The coroutine to run as a task
            tag: Optional tag to identify the task for later cancellation
            
        Returns:
            The created asyncio.Task
        """
        task = asyncio.get_event_loop().create_task(coroutine)
        if tag:
            setattr(task, '_task_tag', tag)
        self.register_task(task)
        return task

    def register_task(self, task: asyncio.Task) -> None:
        """
        Register an existing task for tracking and exception handling.
        
        Args:
            task: The asyncio.Task to register
        """
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

    async def cancel_tasks(
        self,
        tags: Union[None, str, List[str]] = None,
        await_completion: bool = False
    ) -> None:
        """
        Cancel tasks by tag(s). This is the unified *async* method for all task cancellation.
        
        Args:
            tags: None to cancel all tasks, a single tag string, or a list of tag strings
            await_completion: If True, awaits cancelled tasks to complete cleanup
            
        Examples:
            await cancel_tasks()  # Cancel all tasks
            await cancel_tasks('login')  # Cancel tasks tagged 'login'
            await cancel_tasks(['login', 'refresh'])  # Cancel multiple tags
            await cancel_tasks('login', await_completion=True)  # Cancel and await
        """
        if not hasattr(self, 'background_tasks'):
            return
        
        # Normalize tags to a set for easy lookup
        tag_set = None
        if tags is not None:
            if isinstance(tags, str):
                tag_set = {tags}
            else:
                tag_set = set(tags)
        
        tasks_to_cancel = []
        for task in list(self.background_tasks):
            task_tag = getattr(task, '_task_tag', None)
            
            # Decide if this task should be cancelled
            should_cancel = False
            if tag_set is None:
                # Cancel all
                should_cancel = True
            elif task_tag in tag_set:
                # Cancel if tag matches
                should_cancel = True
            
            if should_cancel:
                tasks_to_cancel.append(task)
        
        # Cancel tasks
        for task in tasks_to_cancel:
            if not task.done():
                task.cancel()
            
            if await_completion:
                # Await the task and suppress CancelledError
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            
            # Remove from tracking
            self.background_tasks.discard(task)

    def get_tasks(self, tag: Optional[str] = None) -> List[asyncio.Task]:
        """
        Get a list of tracked tasks, optionally filtered by tag.
        
        Args:
            tag: Optional tag to filter by. If None, returns all tasks.
            
        Returns:
            List of matching tasks
        """
        if not hasattr(self, 'background_tasks'):
            return []
        
        if tag is None:
            return list(self.background_tasks)
        
        return [
            task for task in self.background_tasks
            if getattr(task, '_task_tag', None) == tag
        ]

    def has_tasks(self, tag: Optional[str] = None) -> bool:
        """
        Check if there are any tracked tasks, optionally filtered by tag.
        
        Args:
            tag: Optional tag to filter by. If None, checks all tasks.
            
        Returns:
            True if matching tasks exist, False otherwise
        """
        return len(self.get_tasks(tag)) > 0

    # Compatibility methods (deprecated but kept for backward compatibility during migration)
    def cancel_pending_tasks(self, tag: Optional[str] = None) -> None:
        """
        DEPRECATED: Use cancel_tasks() instead.
        Kept for backward compatibility during migration.
        
        Note: This is a synchronous wrapper that schedules the async cancel_tasks.
        For proper cleanup, use the async cancel_tasks() directly.
        """
        if not hasattr(self, 'background_tasks'):
            return
        # Synchronous cancellation - just cancel without awaiting
        tag_set = None
        if tag is not None:
            tag_set = {tag} if isinstance(tag, str) else set(tag)
        
        for task in list(self.background_tasks):
            task_tag = getattr(task, '_task_tag', None)
            should_cancel = False
            if tag_set is None:
                should_cancel = True
            elif task_tag in tag_set:
                should_cancel = True
            
            if should_cancel:
                if not task.done():
                    task.cancel()
                self.background_tasks.discard(task)

    def cancel_tasks_by_tag(self, tag: str) -> None:
        """
        DEPRECATED: Use cancel_tasks(tag) instead.
        Kept for backward compatibility during migration.
        
        Note: This is a synchronous wrapper. For proper cleanup with await,
        use the async cancel_tasks() directly.
        """
        self.cancel_pending_tasks(tag)

    async def cancel_and_await_tasks_by_tag(self, tag: str) -> None:
        """
        DEPRECATED: Use cancel_tasks(tag, await_completion=True) instead.
        Kept for backward compatibility during migration.
        """
        await self.cancel_tasks(tags=tag, await_completion=True)

    def cancel_task(self, task: asyncio.Task) -> None:
        """
        DEPRECATED: Use cancel_tasks() or cancel the task directly.
        Kept for backward compatibility during migration.
        """
        if not hasattr(self, 'background_tasks'):
            return
        if task in self.background_tasks:
            task.cancel()
            self.background_tasks.discard(task)


class UnauthorizedRestartException(Exception):
    """Raised when a 401 Unauthorized is encountered and a plugin restart is needed."""
    pass