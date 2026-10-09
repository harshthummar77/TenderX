import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  INVOICE_STATUSES,
  PAYMENT_STATUSES,
  PO_STATUSES,
  QUOTATION_STATUSES,
  TENDER_STATUSES,
  VENDOR_STATUSES,
  type DeliveryStatus,
  type InvoiceStatus,
  type PaymentStatus,
  type PoStatus,
  type QuotationStatus,
  type TenderStatus,
  type VendorStatus,
} from '@tb/shared';
import { isAppError } from '../src/lib/errors.js';
import {
  DELIVERY_TRANSITIONS,
  assertDeliveryTransition,
} from '../src/modules/delivery/delivery.stateMachine.js';
import {
  INVOICE_TRANSITIONS,
  assertInvoiceTransition,
} from '../src/modules/invoice/invoice.stateMachine.js';
import {
  PAYMENT_TRANSITIONS,
  assertPaymentTransition,
} from '../src/modules/payment/payment.stateMachine.js';
import { PO_TRANSITIONS, assertPoTransition } from '../src/modules/purchase-order/po.stateMachine.js';
import {
  QUOTATION_TRANSITIONS,
  assertQuotationTransition,
} from '../src/modules/quotation/quotation.stateMachine.js';
import {
  TENDER_TRANSITIONS,
  assertTransition as assertTenderTransition,
} from '../src/modules/tender/tender.stateMachine.js';
import {
  VENDOR_TRANSITIONS,
  assertTransition as assertVendorTransition,
  type VendorAction,
} from '../src/modules/vendor/vendor.stateMachine.js';

/**
 * State machines (plan 18 §4).
 *
 * Table-driven over the transition maps themselves, so the test cannot drift
 * from the machine: adding a status to an enum without adding it to the map is
 * a failure here, not a 500 in week 6.
 *
 * Every legal transition is asserted to pass, and every pair NOT in the map is
 * asserted to throw `*.invalid_transition` — that second half is the valuable
 * one, because it is exhaustive rather than a hand-picked sample.
 */

interface Machine<S extends string> {
  name: string;
  code: string;
  statuses: readonly S[];
  transitions: Record<S, readonly S[]>;
  assert: (from: S, to: S) => void;
}

const machines = [
  {
    name: 'tender',
    code: 'tender.invalid_transition',
    statuses: TENDER_STATUSES,
    transitions: TENDER_TRANSITIONS,
    assert: assertTenderTransition,
  } satisfies Machine<TenderStatus>,
  {
    name: 'quotation',
    code: 'quotation.invalid_transition',
    statuses: QUOTATION_STATUSES,
    transitions: QUOTATION_TRANSITIONS,
    assert: assertQuotationTransition,
  } satisfies Machine<QuotationStatus>,
  {
    name: 'purchase order',
    code: 'po.invalid_transition',
    statuses: PO_STATUSES,
    transitions: PO_TRANSITIONS,
    assert: assertPoTransition,
  } satisfies Machine<PoStatus>,
  {
    name: 'delivery',
    code: 'delivery.invalid_transition',
    statuses: DELIVERY_STATUSES,
    transitions: DELIVERY_TRANSITIONS,
    assert: assertDeliveryTransition,
  } satisfies Machine<DeliveryStatus>,
  {
    name: 'invoice',
    code: 'invoice.invalid_transition',
    statuses: INVOICE_STATUSES,
    transitions: INVOICE_TRANSITIONS,
    assert: assertInvoiceTransition,
  } satisfies Machine<InvoiceStatus>,
  {
    name: 'payment',
    code: 'payment.invalid_transition',
    statuses: PAYMENT_STATUSES,
    transitions: PAYMENT_TRANSITIONS,
    assert: assertPaymentTransition,
  } satisfies Machine<PaymentStatus>,
] as unknown as Machine<string>[];

/** The thrown value is an AppError with the module's stable code and a 422. */
const expectInvalidTransition = (run: () => void, code: string) => {
  try {
    run();
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      expect(error.status).toBe(422);
    }
    return;
  }
  throw new Error(`Expected ${code}`);
};

describe.each(machines)('$name state machine', (machine) => {
  it('covers every status in the enum', () => {
    expect(Object.keys(machine.transitions).sort()).toEqual([...machine.statuses].sort());
  });

  it('admits every legal transition', () => {
    for (const from of machine.statuses) {
      for (const to of machine.transitions[from] ?? []) {
        expect(() => machine.assert(from, to)).not.toThrow();
      }
    }
  });

  it('refuses every transition that is not on the map', () => {
    let checked = 0;

    for (const from of machine.statuses) {
      const legal = machine.transitions[from] ?? [];
      for (const to of machine.statuses) {
        if (legal.includes(to)) continue;
        expectInvalidTransition(() => machine.assert(from, to), machine.code);
        checked += 1;
      }
    }

    // A machine where everything is legal would pass the loop above vacuously.
    expect(checked).toBeGreaterThan(0);
  });

  it('never lets a terminal status move on', () => {
    const terminal = machine.statuses.filter((s) => (machine.transitions[s] ?? []).length === 0);

    for (const from of terminal) {
      for (const to of machine.statuses) {
        expectInvalidTransition(() => machine.assert(from, to), machine.code);
      }
    }
  });
});

/**
 * The vendor machine is keyed by action rather than target status — approving
 * and reinstating both land on APPROVED, and the audit trail needs to know
 * which one happened (06 §1).
 */
describe('vendor state machine', () => {
  const actions = Object.keys(VENDOR_TRANSITIONS) as VendorAction[];

  it('returns the target status for every legal action', () => {
    for (const action of actions) {
      for (const from of VENDOR_TRANSITIONS[action].from) {
        expect(assertVendorTransition(from, action)).toBe(VENDOR_TRANSITIONS[action].to);
      }
    }
  });

  it('refuses every action the current status does not allow', () => {
    for (const action of actions) {
      const allowed = VENDOR_TRANSITIONS[action].from;
      for (const from of VENDOR_STATUSES as readonly VendorStatus[]) {
        if (allowed.includes(from)) continue;
        expectInvalidTransition(
          () => assertVendorTransition(from, action),
          'vendor.invalid_transition',
        );
      }
    }
  });

  it('has no way out of BLACKLISTED', () => {
    for (const action of actions) {
      expectInvalidTransition(
        () => assertVendorTransition('BLACKLISTED', action),
        'vendor.invalid_transition',
      );
    }
  });
});
