import type { DomainRegister } from '../core/tool-factory.js';

import { register as auth } from '../domains/auth.js';
import { register as user } from '../domains/user.js';
import { register as items } from '../domains/items.js';
import { register as messenger } from '../domains/messenger.js';
import { register as autoload } from '../domains/autoload.js';
import { register as orders } from '../domains/orders.js';
import { register as delivery } from '../domains/delivery.js';
import { register as promotion } from '../domains/promotion.js';
import { register as cpa } from '../domains/cpa.js';
import { register as cpaTarget } from '../domains/cpa_target_action.js';
import { register as stock } from '../domains/stock.js';
import { register as hierarchy } from '../domains/hierarchy.js';
import { register as reviews } from '../domains/reviews.js';
import { register as tariffs } from '../domains/tariffs.js';
import { register as cpaAuction } from '../domains/cpa_auction.js';
import { register as trxpromo } from '../domains/trxpromo.js';
import { register as calltracking } from '../domains/calltracking.js';
import { register as msgDiscounts } from '../domains/messenger_discounts.js';
import { register as webhook } from '../domains/webhook.js';
import { register as meta } from '../domains/meta.js';

/**
 * Domain registry. Each swagger → one file in src/domains/ exporting a register function.
 * Adding a new swagger requires one line here + one file there.
 *
 * Order is not critical (tool names are unique), but we follow the planned priority.
 */
export const domains: readonly DomainRegister[] = [
  meta,
  auth,
  user,
  items,
  messenger,
  autoload,
  orders,
  delivery,
  promotion,
  cpa,
  cpaTarget,
  stock,
  hierarchy,
  reviews,
  tariffs,
  cpaAuction,
  trxpromo,
  calltracking,
  msgDiscounts,
  webhook,
];
