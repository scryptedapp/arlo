# Arlo Plugin Refactor Plan - Copilot Instructions

## Overview
This document outlines the phased refactoring plan to stabilize the Arlo plugin. The goal is to eliminate distributed plugin restarts on transient 401 errors, centralize session recovery, improve connection management, and ensure graceful handling of authorization failures.

## Background
The current plugin implementation has several stability issues:
1. **Distributed restarts**: 401 errors trigger plugin restarts from multiple layers (request.py, client.py, mqtt_stream.py, sse_stream.py), causing unnecessary disruption
2. **No centralized orchestration**: No single point controls when to attempt soft relogin vs. hard restart
3. **Task cancellation bugs**: `cancel_pending_tasks(tag)` had inverted semantics - it cancelled everything EXCEPT the specified tag (FIXED in PR1)
4. **Redundant task APIs**: Multiple overlapping functions (`cancel_pending_tasks`, `cancel_tasks_by_tag`, `cancel_and_await_tasks_by_tag`) made the API confusing (SIMPLIFIED in PR1)
5. **Stream lifecycle issues**: MQTT/SSE streams lack deterministic disconnect, reconnect, and backoff logic
6. **Settings change handling**: No proper diff detection, causing unnecessary full restarts

## Phased Refactor Plan

### PR 1: Centralize 401 Handling & Fix Task Cancellation (CURRENT)
**Status**: In Progress  
**Target Branch**: purepython_wip

#### Goals
- Stop distributed plugin restarts on transient 401s
- Centralize unauthorized handling in provider
- Fix task cancellation semantics
- Add Copilot instructions to guide subsequent PRs

#### Changes
1. **COPILOT_INSTRUCTIONS.md** (this file)
   - Full plan for PR 1-6
   
2. **arlo/client/request.py**
   - On HTTP 401 (response.status_code or caught RequestException with response 401):
     - Call `provider.handle_unauthorized(f"{method} {url}")` if provider available
     - Raise `UnauthorizedRestartException("401 Unauthorized")`
   - Update logging: "deferring to provider" instead of "triggering plugin restart"

3. **arlo/client/client.py**
   - Remove ALL calls to `scrypted_sdk.deviceManager.requestRestart()` from UnauthorizedRestartException handlers
   - Log and return safe defaults ([], {}, None) where appropriate
   - Provider will perform recovery via handle_unauthorized
   - Affected methods: get_devices, get_device_capabilities, get_device_smart_features, trigger_properties, get_locations, get_mode_and_revision, set_mode, subscribe, unsubscribe, get_sip_info, get_sip_info_v2, start_push_to_talk, notify_push_to_talk_offer_sdp, notify_push_to_talk_offer_candidate, siren_on/off, spotlight_on/off, floodlight_on/off, nightlight_on/off, charge_notification_led_on/off, brightness_set, restart_device, create_certificates, get_library

4. **arlo/client/mqtt_stream.py**
   - In `start()`: On persistent connection failures or connection wait timeout
   - Remove calls to `scrypted_sdk.deviceManager.requestRestart()`
   - Log failure and return (Provider will decide next steps via subscribe_to_event_stream retry logic)
   - Remove unused scrypted_sdk import if no longer used

5. **arlo/client/sse_stream.py**
   - In `start()`: On exception
   - Remove plugin restart calls
   - Log and return
   - Leave reconnect-on-thread-exception behavior
   - Remove unused scrypted_sdk import if no longer used

6. **arlo/util.py**
   - Fix `BackgroundTaskMixin.cancel_pending_tasks(tag)` semantics:
     - If `tag` is None: cancel ALL tasks
     - If `tag` is provided: cancel ONLY tasks with that tag (behavior was inverted)
   - **BONUS SIMPLIFICATION**: Consolidate redundant task APIs:
     - New unified method: `cancel_tasks(tags=None, await_completion=False)`
       - `tags=None`: cancel all
       - `tags='login'`: cancel single tag
       - `tags=['login', 'refresh']`: cancel multiple tags
       - `await_completion=True`: await cancelled tasks
     - New helper methods:
       - `get_tasks(tag=None)`: Get tasks by tag or all
       - `has_tasks(tag=None)`: Check if tasks exist
     - Keep old methods as deprecated wrappers for backward compatibility
   - Update all usages in provider.py, base.py, webrtc_sip.py to use new API

7. **arlo/provider.py**
   - Add fields in `__init__`:
     - `self._401_count = 0`
     - `self._last_401_time = 0.0`
   - Add `handle_unauthorized(self, context: str)` stub:
     - Increment 401 counter with timestamp
     - Log warning (no relogin logic yet; full orchestration in PR 2)
   - In `_initialize_plugin()`:
     - Replace multiple `cancel_and_await_tasks_by_tag()` calls
     - With single simplified call:
       ```python
       await self.cancel_tasks(
           tags=['periodic_discovery', 'periodic_refresh', 'mfa', 'login-arlo', 'login', 'refresh', 'heartbeat'],
           await_completion=True
       )
       ```
   - Update all other task cancellation calls to use simplified API

#### What NOT to Change
- Do NOT implement full orchestrator logic (soft relogin, graceful restart) - PR 2
- Do NOT change SSE/MQTT disconnect semantics beyond removing restarts - PR 3
- Do NOT refactor settings diff logic - PR 5

#### Acceptance Criteria
- ✅ A 401 from request.py no longer triggers plugin restart directly
- ✅ It calls provider.handle_unauthorized and raises UnauthorizedRestartException
- ✅ Client/stream layers handle gracefully
- ✅ No direct deviceManager.requestRestart in client Unauthorized handlers
- ✅ No direct deviceManager.requestRestart in mqtt_stream.py/sse_stream.py start error paths
- ✅ `cancel_pending_tasks(tag)` cancels only matching tags when provided (all when tag=None)
- ✅ **NEW**: Simplified task API with single `cancel_tasks()` method replacing 3 redundant methods
- ✅ **NEW**: Helper methods `get_tasks()` and `has_tasks()` for task inspection
- ✅ All task cancellation calls updated to use simplified API throughout codebase
- ✅ provider._initialize_plugin no longer cancels itself due to changed semantics
- ✅ COPILOT_INSTRUCTIONS.md present with full plan

---

### PR 2: Session Orchestrator & Recovery Logic
**Status**: Not Started  
**Target Branch**: purepython_wip

#### Goals
- Implement centralized session recovery orchestration
- Add soft relogin capability (reuse existing session)
- Add graceful restart with exponential backoff
- Distinguish between transient 401s and hard auth failures

#### Changes
1. **arlo/provider.py**
   - Implement full `handle_unauthorized(context: str)` logic:
     - Detect rapid repeated 401s (rate limiting threshold)
     - Attempt soft relogin first (clear token, re-auth without logout)
     - On soft relogin failure, perform graceful restart with backoff
     - Track failure patterns and escalate to user notification if persistent
   - Add `soft_relogin()` method
   - Add `graceful_restart()` method with exponential backoff
   
2. **arlo/client/client.py**
   - Add `soft_relogin()` method that reuses session but refreshes token
   - Preserve event stream connection during soft relogin if possible

3. **Integration**
   - Wire provider.handle_unauthorized to trigger appropriate recovery
   - Add state machine: normal → soft_relogin → graceful_restart → user_intervention

#### Acceptance Criteria
- ✅ Transient 401s trigger soft relogin, not full restart
- ✅ Persistent 401s (after retries) trigger graceful restart with backoff
- ✅ Hard auth failures (wrong credentials) notify user without restart loop
- ✅ Event streams preserved during soft relogin when possible

---

### PR 3: Deterministic Stream Lifecycle Management
**Status**: Not Started  
**Target Branch**: purepython_wip

#### Goals
- Add deterministic connect/disconnect/reconnect logic for MQTT/SSE
- Implement exponential backoff with jitter
- Add connection health monitoring
- Prevent reconnect storms

#### Changes
1. **arlo/client/stream.py** (base class)
   - Add connection state machine
   - Add exponential backoff calculator
   - Add connection health tracking

2. **arlo/client/mqtt_stream.py**
   - Implement deterministic disconnect
   - Add connection health checks
   - Implement backoff on reconnect failures
   - Add max reconnect attempts before escalating to provider

3. **arlo/client/sse_stream.py**
   - Same as mqtt_stream.py
   - Ensure thread safety for state transitions

4. **arlo/provider.py**
   - Handle stream escalation events
   - Coordinate stream restart with session state

#### Acceptance Criteria
- ✅ Stream connections use exponential backoff on failure
- ✅ Max reconnect attempts configurable
- ✅ Stream failures escalate to provider after exhausting retries
- ✅ No reconnect storms or tight loops
- ✅ Graceful cleanup on disconnect

---

### PR 4: Comprehensive Error Handling & Logging
**Status**: Not Started  
**Target Branch**: purepython_wip

#### Goals
- Standardize error handling patterns
- Improve diagnostic logging
- Add error categorization (transient vs. permanent)
- Better user-facing error messages

#### Changes
1. **arlo/util.py**
   - Add error classification utilities
   - Add `RetryableException`, `PermanentException` base classes

2. **All client modules**
   - Classify exceptions as retryable or permanent
   - Add context to exceptions (operation, device, timing)
   - Improve error messages

3. **arlo/logging.py**
   - Add structured logging helpers
   - Add diagnostic dump on critical errors
   - Add performance metrics logging (optional)

4. **arlo/provider.py**
   - Implement error aggregation
   - Surface persistent errors to user via Scrypted UI
   - Add health status reporting

#### Acceptance Criteria
- ✅ Clear distinction between transient and permanent errors
- ✅ All exceptions include context (what, where, when)
- ✅ User sees clear error messages in Scrypted UI
- ✅ Diagnostic logs available for troubleshooting
- ✅ No silent failures

---

### PR 5: Settings Change Handling & Diffing
**Status**: Not Started  
**Target Branch**: purepython_wip

#### Goals
- Implement proper settings diff detection
- Only restart affected components on settings change
- Avoid unnecessary full plugin restarts
- Validate settings before applying

#### Changes
1. **arlo/provider.py**
   - Add `_compute_settings_diff(old_settings, new_settings)` method
   - Add `_apply_settings_change(diff)` method
   - Categories:
     - **Requires full restart**: username, password, device_id
     - **Requires client restart**: event_stream_transport, http_mode
     - **Requires stream restart**: event_stream_refresh_interval
     - **Hot-reload**: log_level, discovery_interval, refresh_interval
   - Implement targeted restart logic per category
   - Add settings validation

2. **Settings UI**
   - Add validation hints
   - Show which settings require restart

#### Acceptance Criteria
- ✅ Changing log level does not restart plugin
- ✅ Changing discovery interval does not restart plugin
- ✅ Changing credentials triggers full restart
- ✅ Changing stream transport restarts only stream, not full plugin
- ✅ Invalid settings rejected before apply

---

### PR 6: Connection Pool & Rate Limiting
**Status**: Not Started  
**Target Branch**: purepython_wip

#### Goals
- Implement proper HTTP connection pooling
- Add rate limiting to prevent API abuse
- Add request deduplication for simultaneous identical requests
- Improve performance and reliability

#### Changes
1. **arlo/client/request.py**
   - Implement connection pooling (reuse TCP connections)
   - Add per-endpoint rate limiting
   - Add request deduplication cache
   - Add request timeout tuning

2. **arlo/client/client.py**
   - Batch similar requests where possible
   - Add request priority queuing
   - Implement request coalescing for simultaneous identical requests

3. **arlo/provider.py**
   - Configure rate limits based on API tier
   - Monitor rate limit exhaustion
   - Backoff on rate limit errors

#### Acceptance Criteria
- ✅ TCP connections reused across requests
- ✅ Rate limiting prevents API abuse
- ✅ Simultaneous identical requests deduplicated
- ✅ Graceful backoff on rate limit errors
- ✅ Improved performance (reduced latency)

---

## Testing Strategy

### Unit Tests
- Test task cancellation semantics (util.py)
- Test error classification
- Test settings diff computation
- Test backoff calculations

### Integration Tests
- Test 401 handling flow end-to-end
- Test soft relogin vs. hard restart
- Test stream reconnect with backoff
- Test settings change scenarios

### Manual Testing
- Simulate 401 by invalidating session
- Simulate network outage and recovery
- Change various settings combinations
- Monitor logs during normal operation

### Performance Testing
- Measure plugin restart frequency
- Measure connection establishment time
- Measure API request rates
- Monitor memory usage over time

---

## Migration Notes

### For Users
- No action required for PR 1-3
- PR 4 may surface previously silent errors (this is good)
- PR 5 may reduce unnecessary restarts
- PR 6 may improve responsiveness

### For Developers
- Review new error handling patterns
- Update any custom integrations to use new error types
- Test against staging before merging to main
- Update documentation as needed

---

## Success Metrics

### Stability
- Reduce plugin restart frequency by 90%
- Reduce 401-triggered restarts to 0
- Increase uptime to 99.9%

### Performance
- Reduce average API latency by 30%
- Reduce connection establishment time by 50%
- Improve responsiveness (faster event delivery)

### Maintainability
- Clear error messages for all failure modes
- Comprehensive logging for troubleshooting
- Well-documented code with clear separation of concerns
- Testable components with good coverage

---

## Glossary

- **Soft relogin**: Refresh authentication token without full logout/login cycle
- **Graceful restart**: Restart with cleanup, backoff, and state preservation
- **Hard restart**: Full plugin restart (nuclear option)
- **Transient error**: Temporary failure that may resolve on retry
- **Permanent error**: Failure requiring user intervention
- **Distributed restart**: Multiple layers independently triggering restart (bad)
- **Centralized orchestration**: Single point of control for recovery (good)

---

## Notes for Future PRs

### PR 2 Considerations
- Consider using existing session cookies during soft relogin
- Implement circuit breaker pattern for repeated failures
- Add telemetry for success/failure rates

### PR 3 Considerations
- Consider WebSocket vs. SSE vs. MQTT trade-offs
- Add connection quality metrics (latency, packet loss)
- Consider fallback stream types if primary fails

### PR 4 Considerations
- Consider structured logging format (JSON)
- Add log aggregation hooks for cloud monitoring
- Consider privacy implications of diagnostic data

### PR 5 Considerations
- Consider settings versioning/migration
- Add settings import/export for backup
- Consider per-device settings overrides

### PR 6 Considerations
- Consider HTTP/2 or HTTP/3 for performance
- Add request tracing for debugging
- Consider caching strategy for read-heavy operations

---

**Last Updated**: 2025-11-15  
**Document Version**: 1.0  
**Target Base Branch**: purepython_wip
