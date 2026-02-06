// Narrow store for receipt tracking; legacy implementation lives in messages.js.

import { recordMessageRead, recordMessageDelivered, resetReceiptStore } from '../messages.js';
import { maybeSendDeliveryReceipt } from '../messages/receipts.js';

export { recordMessageRead, recordMessageDelivered, resetReceiptStore, maybeSendDeliveryReceipt };
