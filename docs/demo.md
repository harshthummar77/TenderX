# 10-minute demo script

Plan 20 §2. Rehearse this end to end **on production** three times before the
real one. The dataset `npm run db:seed -- --reset` produces has every seat
reserved for every step below.

## Before you start

1. Warm the stack: `curl https://<api>/api/v1/ready` five minutes early, twice.
   Confirm the second call is under one second.
2. Open four browser profiles and log in as the four roles, each on its own
   tab:
   - `admin@tenderbridge.dev` — platform admin
   - `admin@meridian.test` — buyer org admin (Priya)
   - `officer@meridian.test` — buyer org officer (Rahul)
   - `v1@acme.test` — vendor (Acme)
3. Have the seeded closed tender's URL ready as a fallback for every step. If
   anything on stage fails, **do not debug** — switch to the seeded version
   and keep talking.

## The script

| Min | Act | What to say |
|---|---|---|
| 0:00 | Landing / dashboard. Point at the source-to-pay strip. | *"Procurement runs on email and spreadsheets. This is the middle layer."* |
| 0:45 | **Platform admin** → `/platform/vendors` → open **Zeta Enterprises** → approve. Show the KYC docs panel, the GSTIN checksum, the duplicate-PAN warning. | *"Vetting is a control, not a form."* |
| 1:45 | **Officer** (Rahul) → New tender → two line items → paste from Excel → criteria sliders 60/20/20 → "Suggested vendors" shows why each was suggested (categories, state, past rating) → publish → invitations sent. | — |
| 3:00 | **Vendor** (V1 Acme) → the invited tender → live countdown → fill prices → live totals update → Submit → **seal hash receipt** on screen. | — |
| 4:00 | Back on **Officer** → open the tender just submitted to → the comparison view **says sealed**. Vendor names visible, no amounts, countdown. Then switch to the **BIDDING_CLOSED** demo tender (seeded, has four bids). | *"Even the buyer cannot see prices before the deadline."* |
| 4:45 | Comparison workspace on the seeded closed tender → per-row winner ticks → hover a score for the breakdown (raw → normalised × weight) → Gamma's null rating is handled → recommend rank 1 with a justification longer than 50 characters. | — |
| 5:45 | **Admin** (Priya) → `/approvals` → open the pending approval → note that it is a **different user** than the recommender → approve → **PO generated automatically**. | *"The officer who recommended it cannot approve it. Separation of duties."* |
| 6:30 | Open the PO PDF → GSTIN blocks top of page → **CGST + SGST** (both parties in Gujarat 24) → amount in words. | — |
| 7:00 | **Vendor** (Acme) → the new PO → Accept → create a Delivery for 8 of 12 units → Dispatch. | *"Partial delivery is the normal case."* |
| 7:30 | **Officer** → the delivery's GRN form → accept 7, reject 1 (damaged) → received / accepted / rejected all reconcile. | — |
| 8:00 | **Vendor** → invoice all 12 → submit → **MATCH EXCEPTION**. Walk the match checklist: PO ✓, GRN ✓, price ✓, **quantity ✗**. The Override button is **disabled** for quantity. | *"This is a three-way match. This invoice cannot be paid."* |
| 8:45 | Correct the invoice to 7 → resubmit → **MATCHED** → **Admin** approves → **Admin** records payment with TDS 194C → invoice **PAID** → PO auto-closes → **tender auto-closes**. | *"Nothing closed that tender — it closed because the last invoice was paid."* |
| 9:20 | `/activity` → recent timeline → open an audit row → verify chain. Then in the Neon SQL editor: `UPDATE activity_logs SET summary='tampered' WHERE id=…` → **`UPDATE 0`**. | *"Append-only and hash-chained."* |
| 9:50 | **Admin** dashboard → committed / invoiced / paid as three different numbers. | *"We can explain the gaps between the three."* |

## Three sentences to practise

Memorise these; everything else can be improvised.

1. *"Even the buyer cannot see prices before the deadline."*
2. *"The officer who recommended it cannot approve it. Separation of duties."*
3. *"Nothing closed that tender — it closed because the last invoice was paid."*

## When something fails on stage

- **The screen you were going to show is wrong.** Switch to the seeded closed
  tender for the same step and keep talking. Do not try to fix it.
- **The API is slow.** It is warming up. Narrate a sentence from this page.
- **A page returns 403.** Wrong tab. The four browser profiles are on purpose.
- **A dropdown is empty.** Reseed before the demo, not during it. If live and
  broken, open the pre-seeded version by URL (`/tenders/<id-from-seed>`).

Have fun. The non-trivial parts of this app are visible in the first 30
seconds of each row above; let them speak.
