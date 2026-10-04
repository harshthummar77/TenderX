import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle } from 'lucide-react';
import type { PurchaseOrderDto } from '@tb/shared';
import { formatDate, formatMoney } from '@/lib/format';
import { Tooltip } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/data/StatusBadge';
import { FulfilmentBar } from '@/features/purchaseOrders/components/FulfilmentBar';
import { receivedPercent } from '@/features/purchaseOrders/progress';

/**
 * The purchase-order columns, shared by the buyer list, the vendor list and the
 * orders tab on a vendor's profile — three screens, one definition, so a column
 * added here shows up in all three.
 */
export function poColumns({
  side,
  showParty = true,
}: {
  side: 'buyer' | 'vendor';
  showParty?: boolean;
}): ColumnDef<PurchaseOrderDto, any>[] {
  const partyColumn: ColumnDef<PurchaseOrderDto, any> = {
    id: 'party',
    header: side === 'buyer' ? 'Vendor' : 'Buyer',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="truncate">
        {side === 'buyer' ? row.original.vendor.name : row.original.buyer.name}
      </span>
    ),
  };

  return [
    {
      id: 'poNumber',
      header: 'PO number',
      accessorKey: 'poNumber',
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-medium">{row.original.poNumber}</span>
          {/* The vendor has had longer than the response window (10 §5). */}
          {row.original.awaitingResponse && (
            <Tooltip
              content={
                side === 'buyer'
                  ? 'No response within the agreed window. The order is not cancelled — that is your call.'
                  : 'This order is waiting on your response.'
              }
            >
              <AlertTriangle aria-hidden className="size-3.5 text-warning" />
            </Tooltip>
          )}
        </span>
      ),
    },
    ...(showParty ? [partyColumn] : []),
    {
      id: 'status',
      header: 'Status',
      accessorKey: 'status',
      cell: ({ getValue }) => <StatusBadge status={getValue() as string} />,
    },
    {
      id: 'fulfilment',
      header: 'Fulfilment',
      enableSorting: false,
      cell: ({ row }) => (
        <FulfilmentBar
          status={row.original.fulfilmentStatus}
          percent={receivedPercent(row.original.items)}
        />
      ),
    },
    {
      id: 'expectedDeliveryDate',
      header: 'Expected',
      accessorKey: 'expectedDeliveryDate',
      cell: ({ getValue }) => formatDate(getValue() as string),
    },
    {
      id: 'totalAmount',
      header: 'Total',
      accessorKey: 'totalAmount',
      meta: { numeric: true },
      cell: ({ getValue }) => formatMoney(getValue() as string),
    },
  ];
}
