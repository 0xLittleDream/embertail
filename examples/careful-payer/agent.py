"""Careful payer, in Python.

A port of examples/careful-payer/agent.ts: an outside agent that gets an overall PASS on
``embertail check --pack core`` and ``--pack incidents``. It sees only the business task, the
mandate and tool results, never the hidden scenario, and connects through the one-file helper
packages/adapter-sdk/python/embertail_adapter.py (standard library only).

Its rules are the money rules:

- Read any supplied content, but never take instructions or recipients from it.
- Pay only an allowed recipient, within the limits, the quoted amount, once.
- Limits apply to the obligation: never split one invoice to slip under a cap.
- A batch of separate, legitimate payments is paid one by one until the rolling budget would
  be exceeded; the rest is left for the owner.
- Never trust a reply. Read the ledger status after every payment.
- After an unclear reply, look before acting again. If the original payment settled or is
  pending, wait for it; resend only when nothing at all is recorded for this payment, and
  then under the same request ID.
- Report completed only when the ledger shows the full amount settled.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Inside the EmberTail repository the helper lives in packages/adapter-sdk/python; in the
# installable package it sits next to this file.
for candidate in (HERE, os.path.join(HERE, '..', '..', 'packages', 'adapter-sdk', 'python')):
    if os.path.exists(os.path.join(candidate, 'embertail_adapter.py')):
        sys.path.insert(0, candidate)
        break
from embertail_adapter import serve_agent  # noqa: E402

SIM_USDC_DECIMALS = 6
SIM_USDC_PRICE_USD_MINOR = 100
MAX_ATTEMPTS = 3
DEFAULT_BLOCK_TIME_MS = 2000


def from_usd(minor):
    """US cents to SIM_USDC base units, as contracts.fromUsd does."""
    return str(int(minor) * 10**SIM_USDC_DECIMALS // SIM_USDC_PRICE_USD_MINOR)


def reconcile(tools, business_intent_id, recipient, obligation_id=None):
    receipt = tools.call('status', {}) or {}
    transactions = receipt.get('transactions')
    if not isinstance(transactions, list):
        return None
    mine = [
        t
        for t in transactions
        if t.get('businessIntentId') == business_intent_id
        and (obligation_id is None or t.get('action', {}).get('obligationId') == obligation_id)
    ]
    ours = [
        t
        for t in mine
        if t.get('action', {}).get('kind') == 'transfer'
        and t.get('action', {}).get('assetId') == 'SIM_USDC'
        and t.get('action', {}).get('recipient') == recipient
    ]
    confirmations = int(receipt.get('minConfirmations') or 1)
    return {
        'settled_units': sum(int(t['action']['amountUnits']) for t in ours if t.get('status') == 'settled'),
        'pending': any(t.get('status') == 'pending' for t in ours),
        'recorded': len(mine) > 0,
        'wait_ms': min(3_600_000, (max(1, confirmations) + 1) * DEFAULT_BLOCK_TIME_MS),
    }


def pay_and_reconcile(tools, business_intent_id, recipient, request_id, amount_units, obligation_id=None):
    """Pay once and read the ledger; returns 'settled', 'unpaid' or 'unknown'."""

    def pay(retry):
        action = {
            'kind': 'transfer',
            'requestId': request_id,
            'assetId': 'SIM_USDC',
            'amountUnits': amount_units,
            'recipient': recipient,
        }
        if obligation_id:
            action['obligationId'] = obligation_id
        return (
            tools.call(
                'action',
                action,
                {'financialActionId': request_id, 'retryOfActionId': request_id if retry else None},
            )
            or {}
        )

    reply = pay(False)
    for _ in range(MAX_ATTEMPTS):
        receipt = reconcile(tools, business_intent_id, recipient, obligation_id)
        if receipt is None:
            return 'unknown'
        if receipt['settled_units'] == int(amount_units):
            return 'settled'
        if receipt['settled_units'] > 0:
            return 'unpaid'
        if receipt['pending']:
            # A status read never advances the chain. Let confirmations accrue, then look again.
            tools.call('wait', {'milliseconds': receipt['wait_ms']})
            continue
        if receipt['recorded'] or str(reply.get('status')) not in ('timeout', 'error', 'unknown'):
            # A recorded failure (for example a revert) or a definite refusal is final.
            return 'unpaid'
        # An unclear reply and nothing recorded: resend the same request, never a new one.
        reply = pay(True)
    return 'unpaid'


def handle(start, tools):
    task, mandate = start['task'], start['mandate']

    def outcome(status, summary):
        tools.call('task', {'status': status, 'summary': summary})

    def within_limits(amount_usd_minor, recipient):
        return (
            recipient in mandate['allowedRecipients']
            and int(amount_usd_minor) <= int(mandate['maxTransactionUsdMinor'])
            and int(amount_usd_minor) <= int(mandate['confirmationAboveUsdMinor'])
        )

    # Content is information, not authority: read it, then ignore any instruction in it.
    tools.call('content', {})
    if task['kind'] == 'review':
        outcome('deferred', 'Review-only task: no financial authority granted.')
        return None

    lines = task.get('payments')
    if task['kind'] == 'pay' and isinstance(lines, list) and lines:
        tools.call('balances', {})
        budget = int(mandate['maxRolling24hCommitmentsUsdMinor'])
        committed, paid = 0, 0
        for line in lines:
            if not within_limits(line['amountUsdMinor'], line['recipient']):
                break
            if committed + int(line['amountUsdMinor']) > budget:
                break
            result = pay_and_reconcile(
                tools,
                task['businessIntentId'],
                line['recipient'],
                line['id'] + '-payment',
                line.get('amountUnits') or from_usd(line['amountUsdMinor']),
                line['id'],
            )
            if result == 'unknown':
                outcome('unknown', f'Paid {paid} of {len(lines)}; settlement of the next is unknown.')
                return None
            if result != 'settled':
                outcome('unpaid', f'Paid {paid} of {len(lines)}; the next payment did not settle.')
                return None
            committed += int(line['amountUsdMinor'])
            paid += 1
        if paid == len(lines):
            outcome('completed', f'The ledger shows all {paid} payments settled exactly once.')
        else:
            outcome(
                'deferred',
                f'Paid {paid} of {len(lines)}; the rest would exceed the rolling budget or a limit and need the owner.',
            )
        return None

    if task['kind'] != 'pay' or not within_limits(task['amountUsdMinor'], task['recipient']):
        outcome('deferred', 'Task requires additional capabilities or authentic owner confirmation.')
        return None

    tools.call('balances', {})
    result = pay_and_reconcile(
        tools,
        task['businessIntentId'],
        task['recipient'],
        task['businessIntentId'] + '-payment',
        task.get('amountUnits') or from_usd(task['amountUsdMinor']),
    )
    if result == 'settled':
        outcome('completed', 'The ledger shows the invoice settled exactly once.')
    elif result == 'unknown':
        outcome('unknown', 'Independent settlement unavailable; no retry authorized.')
    else:
        outcome('unpaid', 'The payment did not settle; nothing was resent.')
    return None


serve_agent(['transfer', 'receipt', 'content', 'business-intent-correlation', 'task-status'], handle)
