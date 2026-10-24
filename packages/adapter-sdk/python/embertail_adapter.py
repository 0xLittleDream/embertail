"""EmberTail adapter helper for Python agents (adapter protocol 0.1).

The Python twin of ``serveAgent`` in ``packages/adapter-sdk/src/index.ts``. It is a
transport between your agent and the EmberTail runner, never a security sandbox: run
only code you trust.

Your agent receives the business task and mandate, calls financial tools through
``tools.call``, and may return a completion. EmberTail owns the simulated ledger and
grades what actually happened.

    from embertail_adapter import serve_agent

    def handle(start, tools):
        task, mandate = start['task'], start['mandate']
        tools.call('balances', {})
        ...
        tools.call('task', {'status': 'completed', 'summary': 'Paid the invoice.'})

    serve_agent(['transfer', 'receipt', 'task-status'], handle)

Copy this single file into your project; it has no dependencies beyond the standard
library.
"""

import json
import sys

PROTOCOL_VERSION = '0.1'
OBSERVATION_KINDS = (
    'agent.final_claim',
    'agent.signing_claim',
    'task.observed_state',
    'control.boundary',
    'execution.error',
)


class ToolError(Exception):
    """A tool request the runner refused or that failed."""


def _send(message):
    sys.stdout.write(json.dumps(message, separators=(',', ':')) + '\n')
    sys.stdout.flush()


class Tools:
    """Financial tools exposed by the runner for the current case."""

    def __init__(self, lines):
        self._lines = lines
        self._next_id = 0

    def call(self, name, args=None, lineage=None):
        """Request a tool and wait for its result.

        ``lineage`` optionally links the call to a business intent:
        ``{'financialActionId': ..., 'retryOfActionId': None, 'agentTurnId': ...}``.
        """
        self._next_id += 1
        request = {'type': 'tool_request', 'id': self._next_id, 'name': name, 'args': args or {}}
        if lineage:
            request['lineage'] = lineage
        _send(request)
        for line in self._lines:
            message = json.loads(line)
            if message.get('type') != 'tool_result':
                raise ToolError(f'Unexpected message while waiting for {name}: {message.get("type")}')
            if message.get('id') != self._next_id:
                raise ToolError('Unknown tool response ID')
            if message.get('error'):
                raise ToolError(str(message['error']))
            return message.get('result')
        raise ToolError('Runner closed the connection')

    def observe(self, kind, payload):
        """Report an observation (for example the agent's final claim)."""
        if kind not in OBSERVATION_KINDS or not isinstance(payload, dict):
            raise ValueError('Invalid observation')
        _send({'type': 'observation', 'observation': {'kind': kind, 'payload': payload}})


def serve_agent(capabilities, handle):
    """Run one EmberTail case: say hello, wait for start_case, run ``handle``, finish.

    ``handle(start, tools)`` may return ``None`` or a completion dict:
    ``{'taskFinalState': 'completed' | 'deferred' | 'unpaid', 'agentFinalClaim': str}``.
    """
    _send({'type': 'hello', 'protocolVersion': PROTOCOL_VERSION, 'capabilities': list(capabilities)})
    lines = iter(sys.stdin.readline, '')
    for line in lines:
        message = json.loads(line)
        if message.get('type') != 'start_case':
            continue
        try:
            completion = handle(message, Tools(lines))
        except Exception as error:  # report any agent failure to the runner, then stop
            payload = {'type': 'error', 'message': str(error) or type(error).__name__}
            if getattr(error, 'status', None) in (402, 429) or getattr(error, 'code', None) == 'PROVIDER_LIMIT':
                payload['code'] = 'PROVIDER_LIMIT'
            _send(payload)
            sys.exit(1)
        _send({'type': 'finish', 'completion': completion} if completion else {'type': 'finish'})
        return
