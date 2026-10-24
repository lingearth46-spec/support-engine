# Late-delivery module (optional)

Decides the right reply for a parcel that is late, failed or stuck, asks the customer the right follow-up, and (where a courier client exists) acts on the courier: reschedule, change phone or address, raise a ticket, message the customer when the parcel moves.

## How it plugs in

The rest of the bot reaches this folder through one file: **`src/engine/lateModule.ts`**, which re-exports `index.ts` here. Nothing else outside this folder imports it. Search for `@late/` to check.

## Switching it off

It is off unless configured. These all default to off:

| Switch | Meaning |
|---|---|
| `SUPPORT_DELIVERY_AGENT` | `off`, `shadow` (decides and records, sends nothing) or `live` |
| `SUPPORT_DELIVERY_AGENT_RATE` | share of customers, when live |
| `SUPPORT_DELIVERY_AGENT_ACTIONS` | allow courier actions (reschedule, phone or address changes) |
| `SUPPORT_DELIVERY_AGENT_TICKETS` | `off`, `dry` or `on`: raise courier tickets |
| `SUPPORT_DELIVERY_UPDATES` | `off`, `dry` or `on`: message customers when a parcel moves |

**Not provided yet:** a version of this module with the code removed. The engine still compiles against the real module, so deleting the folder needs stubs for the entry points listed in `index.ts`. Until then, "off" means configured off.

## What is courier-specific

The reference shop uses Delhivery and Shadowfax (India). Scan wording, reschedule rules, ticket categories and the idea of an "NDR" (non-delivery report) are theirs. To use another courier, write a client in `src/adapters/couriers/` and adapt `deliveryCaseState.ts`, which turns a courier's scan vocabulary into the module's states. Expect this to be the largest piece of work after the order source.

## Not in this kit

The reference shop's browser automation for a courier's web portal (used to raise Delhivery tickets) is not published. `deliveryTicketExecutor.ts` queues the requests; the portal runner that raises them is yours to write or to skip.

## Related files kept in the engine

The replies that every deployment needs, such as the fixed late-parcel lines and the reassurance rule, live in `src/engine/`: `lateDeliveryReply.ts`, `lateReassurance.ts`, `lateEscalate.ts`, `parcelScan.ts`, `ndrTitleReply.ts`, `courierPushCancel.ts`, `courierCod.ts`, `states.ts`, `returnTracking.ts`.
