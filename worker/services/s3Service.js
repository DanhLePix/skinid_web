/**
 * S3 Retail Software Integration Service (ES3)
 * API host is m.es3.vn; the Fieldman back-office UI lives at fm.es3.vn.
 * (m.present.es3.vn and m.fm.es3.vn both fail TLS: the *.es3.vn certificate does not
 * cover them, so neither is a usable API host.)
 * Manages authentication, token caching, customer sync, order payload mapping, and resilient API dispatching.
 */

import { getS3Config } from '../app/env.js';

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedAccount = '';

/**
 * Reset token cache (useful for tests)
 */
export function resetS3TokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
  cachedAccount = '';
}

/**
 * Retrieve or refresh authentication token from S3 API
 * Endpoint: POST /Vision/Accounts/Login/v3
 */
export async function getOrRefreshToken(config, fetchFn = fetch) {
  const now = Date.now();
  const account = `${config.baseUrl}:${config.username}:${config.password}`;
  if (cachedToken && cachedAccount === account && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const baseUrl = (config.baseUrl || 'https://m.es3.vn').replace(/\/+$/, '');
  const loginUrl = `${baseUrl}/Vision/Accounts/Login/v3`;

  const response = await fetchFn(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      Username: config.username,
      Password: config.password
    })
  });

  if (!response.ok) {
    throw new Error(`S3 Login HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  const token = data.AuthenticationData?.AccessToken;
  if (!token) {
    throw new Error(`S3 Login failed: ${data.Message || 'No AccessToken returned'}`);
  }

  cachedToken = token;
  cachedAccount = account;
  // Tokens typically expire in 24h (86400s)
  tokenExpiresAt = now + 86400 * 1000;

  return cachedToken;
}

/**
 * Format a date the way S3 stores invoice dates.
 * "Tài liệu API tích hợp ES3 v1.4" documents "2024-11-20T14:06:45+07:00"; sending a UTC
 * "Z" timestamp instead makes S3 record the previous day for any invoice created before
 * 07:00 Vietnam time, so the sales report lands on the wrong date.
 * Vietnam has no daylight saving, so a fixed +07:00 offset is always correct.
 */
export function toS3InvoiceDate(date = new Date()) {
  const vietnamTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return vietnamTime.toISOString().replace(/\.\d{3}Z$/, '+07:00');
}

/**
 * S3 answers a retried RequestId with code "01" and "Lỗi trùng requestId".
 * That is not a failure: RequestId is derived from the order id, so it proves this exact
 * order already holds an invoice. Treating it as ambiguous would block the order forever
 * and force an admin to reconcile an invoice that is already correct.
 */
export function isDuplicateRequestId(responseData = {}) {
  const code = String(responseData.code ?? '');
  const message = String(responseData.message || responseData.Message || '');
  return code === '01' && /trùng\s*requestid/i.test(message);
}

/**
 * Create or sync customer on S3 POS
 * Endpoint: POST /Vision/Customers/Search & POST /Vision/Customers
 */
export async function syncCustomerToS3({ customer, token, config = {}, fetchFn = fetch }) {
  const phone = String(customer?.phone || '').trim();
  const baseUrl = (config?.baseUrl || 'https://m.es3.vn').replace(/\/+$/, '');

  // 1. Search existing customer by phone if available
  if (phone) {
    try {
      const searchRes = await fetchFn(`${baseUrl}/Vision/Customers/Search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ KeySearch: phone })
      });
      if (searchRes.ok) {
        const matches = await searchRes.json().catch(() => []);
        if (Array.isArray(matches) && matches.length > 0 && matches[0]?.Id) {
          return Number(matches[0].Id);
        }
      }
    } catch (err) {
      console.warn('[S3 Customer Search Warning]', err.message);
    }
  }

  if (!phone && !customer?.name) return 0;

  // 2. Create new customer if not found
  const custUrl = `${baseUrl}/Vision/Customers`;
  const fullName = String(customer.name || 'Khách hàng SkinID').trim();
  const nameParts = fullName.split(' ');
  const lastName = nameParts.length > 1 ? nameParts[0] : '';
  const firstName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : fullName;

  try {
    const res = await fetchFn(custUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        Id: 0,
        FirstName: firstName,
        LastName: lastName,
        BirthdayDay: 0,
        BirthdayMonth: 0,
        Email: customer.email || '',
        Company: 'SkinID Web Customer',
        Address: customer.address || '',
        Phone: phone,
        Mobile: phone,
        Fax: '',
        Notes: `Đăng ký từ SkinID.vn | SĐT: ${phone}`,
        Gender: 'M',
        City: 'Hồ Chí Minh',
        Country: 'VN',
        IsActive: true,
        IsCustomer: true,
        CustomerCategoryIds: ''
      })
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.Success && data.SingleData) {
        return Number(data.SingleData);
      }
    }
  } catch (err) {
    console.warn('[S3 Customer Create Warning]', err.message);
  }

  // Create returns Success:false / SingleData:0 when the phone already exists
  // (e.g. the search above raced or failed). Re-search before giving up, because
  // CustomerId 0 makes S3 reject the whole preorder/invoice with code 01.
  if (phone) {
    try {
      const retry = await fetchFn(`${baseUrl}/Vision/Customers/Search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ KeySearch: phone })
      });
      if (retry.ok) {
        const matches = await retry.json().catch(() => []);
        if (Array.isArray(matches) && matches.length > 0 && matches[0]?.Id) {
          return Number(matches[0].Id);
        }
      }
    } catch (err) {
      console.warn('[S3 Customer Re-search Warning]', err.message);
    }
  }

  return 0;
}

/**
 * Split an order into the two amounts S3 keeps separately.
 *
 * "Tài liệu API tích hợp ES3 v1.4" defines them explicitly:
 *   TotalAmount   = "Tổng số tiền sản phẩm chưa áp dụng khuyến mãi, giảm giá"
 *   InvoiceAmount = "Tổng số tiền sau khi trừ khuyến mãi, giảm giá"
 *
 * So TotalAmount is the merchandise gross and InvoiceAmount is what the customer pays.
 * `order.total` already has the discount removed, which is why it may never stand in for
 * the gross: a missing `subtotal` used to file the discounted amount as the gross and the
 * S3 revenue report booked less merchandise than was actually sold. The order lines are
 * the authoritative source of the gross when `subtotal` is absent.
 */
export function invoiceTotals(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsGross = items.reduce((sum, item) => {
    const price = Number(item?.price ?? item?.unitPrice ?? 0);
    const quantity = Number(item?.quantity ?? 1);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) return sum;
    return sum + price * quantity;
  }, 0);

  const discount = Math.max(0, Number(order.discountAmount) || 0);
  const declaredSubtotal = Number(order.subtotal);
  const declaredTotal = Number(order.total);

  const net = Number.isFinite(declaredTotal) && declaredTotal > 0
    ? declaredTotal
    : Math.max(0, itemsGross - discount);

  let gross = Number.isFinite(declaredSubtotal) && declaredSubtotal > 0 ? declaredSubtotal : itemsGross;
  // Neither subtotal nor lines survived: rebuild the gross by adding the discount back to
  // the charged amount rather than reporting the net as the gross.
  if (!(gross > 0)) gross = net + discount;

  return { gross, net, discount };
}

/**
 * Map SkinID order to S3 PreOrder payload
 * Follows "Tài liệu API tích hợp ES3 v1.4" Section 8
 */
export function mapOrderToS3Payload(order, config, customerId = 0) {
  const isBankTransfer = order.paymentMethod === 'bank_transfer';
  const orderId = String(order.id || order.orderId || '').trim();
  const branchId = Number(config.branchId || 9099);
  const cashierId = Number(config.cashierId || 16614);
  const totals = invoiceTotals(order);

  const preOrderItems = (order.items || []).map((item, index) => {
    const unitPrice = Number(item.price || item.unitPrice || 0);
    const quantity = Number(item.quantity || 1);
    const productId = Number(item.s3ProductId || item.skuNumber || 0);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new Error(`Chưa ánh xạ mã S3 cho sản phẩm ${item.productId || item.sku || item.name || index}.`);
    }
    const code = String(item.productCode || item.sku || '').trim();
    const rawName = String(item.name || item.productName || 'Sản phẩm SkinID').trim();
    const productName = code && !rawName.includes(code)
      ? `[${code}] ${rawName}`.slice(0, 200)
      : rawName.slice(0, 200);

    return {
      YS_ProductID: productId,
      QuantitySold: quantity,
      PriceSold: unitPrice,
      Discount: "0",
      Attributes: code ? `SKU: ${code}` : "",
      AttributeKey: "",
      ReferenceCode: 0,
      UnitCost: unitPrice,
      MultiUOMKey: "",
      PromotionsKey: "",
      ProductName: productName,
      UOMDisplay: "Cái",
      ImageUrl: item.imageUrl || "",
      YS_PreOrderItemID: 0,
      CurrentQuantityFree: 0,
      CurrentAmountFree: 0,
      TotalQuantityFree: 0,
      TotalAmountFree: 0,
      BaseUOMID: 0,
      UOMID: 0,
      ExchangedVal: 0,
      OriginalPrice: unitPrice,
      IsChangedPrice: false,
      UOMs: null,
      Promotions: null,
      ProductVAT: "0",
      ProductVATTaxAmount: 0
    };
  });

  // S3 rejects the entire preorder with code 01 when CustomerID is 0.
  const resolvedCustomerId = Number(customerId || order.s3CustomerId || 0);
  if (!Number.isSafeInteger(resolvedCustomerId) || resolvedCustomerId <= 0) {
    throw new Error(`Không xác định được mã khách hàng S3 cho đơn ${orderId}.`);
  }

  return {
    PreOrder: {
      YS_PreOrderID: 0,
      Cashier: cashierId,
      CustomerID: resolvedCustomerId,
      InvoiceDiscount: Number(order.discountAmount || 0),
      TotalAmount: totals.gross,
      InvoiceAmount: totals.net,
      CustomerReceived: order.paymentStatus === 'paid' ? totals.net : 0,
      Notes: `[SkinID Đơn: #${orderId.slice(0, 8)}] ${order.note || ''} | ${isBankTransfer ? 'Vietcombank 1063583549' : 'COD'}`.trim(),
      PromotionName: order.couponCode ? `Voucher ${order.couponCode}` : "",
      PromotionAmount: Number(order.discountAmount || 0),
      PromotionDiscount: order.discountAmount ? String(order.discountAmount) : "0",
      PromotionDiscountAmount: Number(order.discountAmount || 0),
      NgayLayHang: null,
      HadChangedProductPrice: false,
      HadDiscountProduct: Number(order.discountAmount || 0) > 0,
      VAT: 0,
      VATTaxAmount: 0
    },
    PreOrderPayments: [],
    PreOrderItems: preOrderItems,
    StorefrontOrderID: 0,
    SelectedBranch: branchId,
    RequestId: `SKINID-${orderId.slice(0, 16) || Date.now()}`
  };
}

/**
 * Map SkinID order to S3 sales invoice payload
 * Follows "Tài liệu API tích hợp ES3 v1.4" Section 3: deducts stock and issues the e-invoice.
 */
export function mapOrderToS3InvoicePayload(order, config, customerId = 0) {
  const isBankTransfer = order.paymentMethod === 'bank_transfer';
  const orderId = String(order.id || order.orderId || '').trim();
  const branchId = Number(config.branchId || 9099);
  const cashierId = Number(config.cashierId || 16614);
  const totals = invoiceTotals(order);
  const { gross, net: total, discount } = totals;
  const sourceItems = Array.isArray(order.items) ? order.items : [];
  if (!sourceItems.length) {
    throw new Error(`Đơn ${orderId} không có sản phẩm để xuất hoá đơn.`);
  }

  const items = sourceItems.map((item, index) => {
    const unitPrice = Number(item.price || item.unitPrice || 0);
    const quantity = Number(item.quantity || 1);
    const productId = Number(item.s3ProductId || item.skuNumber || 0);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new Error(`Chưa ánh xạ mã S3 cho sản phẩm ${item.productId || item.sku || item.name || index}.`);
    }
    const code = String(item.productCode || item.sku || '').trim();
    const rawName = String(item.name || item.productName || 'Sản phẩm SkinID').trim();
    const productName = code && !rawName.includes(code)
      ? `[${code}] ${rawName}`.slice(0, 200)
      : rawName.slice(0, 200);

    return {
      YS_ProductID: productId,
      QuantitySold: quantity,
      PriceSold: unitPrice,
      Discount: "0",
      Attributes: code ? `SKU: ${code}` : "",
      AttributeKey: "",
      ReferenceCode: 0,
      UnitCost: unitPrice,
      MultiUOMKey: "",
      PromotionsKey: "",
      ProductName: productName,
      UOMDisplay: "Cái",
      ImageUrl: item.imageUrl || "",
      ProductVAT: "0",
      ProductVATTaxAmount: 0
    };
  });

  // AddNewPreOrder does not return YS_PreOrderID, so the invoice stands alone.
  // The S3 docs mark CustomerId as optional: "Nếu không có khách hàng được chọn =>
  // CustomerId = 0", so a walk-in order must not be blocked here.
  const resolvedCustomerId = Number(customerId || order.s3CustomerId || 0);
  if (!Number.isSafeInteger(resolvedCustomerId) || resolvedCustomerId < 0) {
    throw new Error(`Mã khách hàng S3 không hợp lệ cho đơn ${orderId}.`);
  }

  // S3 answers code "00" even when it silently drops the invoice, so the response
  // alone never proves anything was saved. The condition that actually decides it is
  // CompleteWithCOD: the docs restrict it to orders that carry a customer with a phone
  // and an address ("Trường này được áp dụng khi có chọn khách hàng..."). Sending
  // CompleteWithCOD: true together with CustomerId 0 for a walk-in produced code "00"
  // and no invoice at all — stock stayed put and neither S3's dashboard nor its order
  // list ever showed the sale. Sending CompleteWithCOD: false plus an explicit cash
  // PaymentOption created the invoice for real (stock 57 -> 56, 306.900 d visible in
  // S3). So COD is only used when we actually have a customer to attach it to.
  const canCompleteWithCod = !isBankTransfer && resolvedCustomerId > 0;
  const paymentOption = isBankTransfer
    ? Number(config.paymentOptionTransfer || 48797)
    : Number(config.paymentOptionCash || 48796);

  return {
    RequestId: `SKINID-INV-${orderId.slice(0, 16) || Date.now()}`,
    BranchId: branchId,
    Cashier: cashierId,
    CustomerId: resolvedCustomerId,
    InvoiceAmount: total,
    TotalAmount: gross,
    InvoiceDiscount: discount ? String(discount) : "0",
    Notes: `[SkinID Đơn: #${orderId.slice(0, 8)}] ${order.note || ''} | ${isBankTransfer ? 'Vietcombank 1063583549' : 'COD'}`.trim(),
    CustomerReceived: total,
    ReferenceCode: 0,
    DownPayment: 0,
    PreOrderId: 0,
    InvoiceDate: toS3InvoiceDate(),
    CompleteWithCOD: canCompleteWithCod,
    GetPrintReceipt: false,
    SendMailToCustomer: true,
    // CompleteWithCOD true requires Payments to be null; otherwise Payments must list
    // how the money was taken. Both walk-in and bank transfer therefore need an entry.
    Payments: canCompleteWithCod
      ? null
      : [{ PaymentOption: paymentOption, PaymentAmount: total }],
    Items: items,
    ManageRGBs: []
  };
}

/**
 * Load the branch product catalog so an invoice can be checked before it is sent.
 * Endpoint: GET /Vision/Products/AllPageV2/{pageNumber}
 *
 * This exists because S3 answers Save/v2 with code "00" even when the payload is
 * impossible to save. A live call carrying YS_ProductID 999999999 (no such product)
 * returned {"code":"00","message":"success"} and created nothing. Code "00" is an
 * unconditional acknowledgement, so the only way to catch a silently dropped invoice is
 * to check the data ourselves.
 *
 * Returns null when the catalog cannot be read; callers must treat that as "unknown"
 * and never as "valid", so a catalog outage cannot be mistaken for a clean bill.
 */
export async function fetchS3ProductCatalog({ token, config = {}, fetchFn = fetch, maxPages = 20 }) {
  const baseUrl = (config?.baseUrl || 'https://m.es3.vn').replace(/\/+$/, '');
  const catalog = new Map();
  for (let page = 1; page <= maxPages; page += 1) {
    let data;
    try {
      const response = await fetchFn(`${baseUrl}/Vision/Products/AllPageV2/${page}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });
      if (!response.ok) return null;
      data = await response.json();
    } catch {
      return null;
    }
    const rows = Array.isArray(data?.Data) ? data.Data : [];
    if (!rows.length) break;
    for (const row of rows) {
      const id = Number(row?.id ?? row?.YS_ProductID);
      if (Number.isSafeInteger(id) && id > 0) {
        catalog.set(id, {
          id,
          name: String(row?.name || ''),
          price: Number(row?.price || 0),
          quantityOnHand: Number(row?.quantity_on_hand ?? 0),
          inventory: row?.inventory !== false,
          status: String(row?.status || '')
        });
      }
    }
    const total = Number(data?.Total || 0);
    if (total && catalog.size >= total) break;
  }
  return catalog;
}

/**
 * Read branch-scoped stock levels.
 * Endpoint: POST /Vision/Products/Inventories (Section 7 of the API doc)
 *
 * AllPageV2 reports the product record, while this endpoint reports the quantity the
 * branch actually holds ("QuantityOnHand" for BranchId) — the number S3 will deduct from.
 * Returns null when the catalogue cannot be read, so callers treat an outage as unknown
 * instead of assuming stock exists.
 *
 * The doc describes IncludeInactive as "Có bao gồm sản phẩm không được active không", but
 * the live API inverts it: IncludeInactive true answers with a single inactive row while
 * false answers with all 56 active products. The flag must therefore stay false, or every
 * real product looks absent from the branch.
 */
export async function fetchS3Inventory({ token, config = {}, fetchFn = fetch, includeInactive = false }) {
  const baseUrl = (config?.baseUrl || 'https://m.es3.vn').replace(/\/+$/, '');
  const branchId = Number(config?.branchId || 9099);
  const inventory = new Map();
  const pageSize = 100;
  for (let pageIndex = 1; pageIndex <= 20; pageIndex += 1) {
    let data;
    try {
      const response = await fetchFn(`${baseUrl}/Vision/Products/Inventories`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          BranchId: branchId,
          CategoryId: 0,
          IncludeInactive: includeInactive,
          KeySearch: '',
          PageIndex: pageIndex,
          PageSize: pageSize,
          CheckProductHasStorefrontItem: false,
          GetProductHasQuantityOnHandOnly: false
        })
      });
      if (!response.ok) return null;
      data = await response.json();
    } catch {
      return null;
    }

    const rows = Array.isArray(data?.PageData) ? data.PageData : [];
    if (!rows.length) break;
    for (const row of rows) {
      const id = Number(row?.YS_ProductID ?? row?.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      inventory.set(id, {
        id,
        name: String(row?.ProductName || row?.name || ''),
        quantityOnHand: Number(row?.QuantityOnHand ?? 0),
        // A product flagged NoStockQuantity is a service/voucher: S3 never deducts stock
        // for it, so it must be excluded from both stock checks and stock proof.
        tracked: row?.NoStockQuantity !== true,
        active: row?.Active !== false,
        status: String(row?.Status || (row?.Active === false ? 'inactive' : 'active'))
      });
    }

    const total = Number(data?.TotalCount || 0);
    if (total && inventory.size >= total) break;
    if (rows.length < pageSize) break;
  }
  return inventory;
}

/**
 * Report invoice lines the branch cannot cover with on-hand stock.
 * Selling more than S3 holds either fails silently or leaves stock negative, so the
 * shortage is reported before anything is posted.
 */
export function findStockShortages(items = [], inventory) {
  if (!inventory) return [];
  const needed = new Map();
  for (const line of items) {
    const productId = Number(line?.YS_ProductID);
    const quantity = Number(line?.QuantitySold ?? 1);
    if (!Number.isSafeInteger(productId) || productId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    needed.set(productId, (needed.get(productId) || 0) + quantity);
  }

  const shortages = [];
  for (const [productId, quantity] of needed) {
    const product = inventory.get(productId);
    if (!product || !product.tracked) continue;
    if (quantity > product.quantityOnHand) {
      shortages.push({
        productId,
        name: product.name,
        requested: quantity,
        available: product.quantityOnHand
      });
    }
  }
  return shortages;
}

/**
 * Build the stock that must go back when a delivered order is cancelled or returned.
 *
 * "Tài liệu API tích hợp ES3 v1.4" exposes eleven endpoints and none of them adjusts
 * stock or cancels an invoice, so this cannot be automated: once Save/v2 has deducted
 * stock the only way back is a manual stock adjustment (or a return) inside S3. The
 * caller records these lines on the order so somebody can do exactly that, instead of
 * the shortage being discovered at the next stock take.
 */
export function buildRestockLines(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items
    .map(item => {
      const productId = Number(item?.s3ProductId || item?.skuNumber || 0);
      const quantity = Number(item?.quantity || 0);
      if (!Number.isSafeInteger(productId) || productId <= 0) return null;
      if (!Number.isFinite(quantity) || quantity <= 0) return null;
      return {
        s3ProductId: productId,
        name: String(item?.name || item?.productName || item?.productId || productId),
        quantity
      };
    })
    .filter(Boolean);
}

/**
 * Compare invoice lines against the branch catalog.
 * Every line must reference a product that exists and is still active, because S3
 * discards an invoice containing an unknown product while still answering code "00".
 */
export function findInvoiceLineProblems(items = [], catalog) {
  if (!catalog) return [];
  const problems = [];
  for (const line of items) {
    const productId = Number(line?.YS_ProductID);
    const product = catalog.get(productId);
    if (!product) {
      problems.push(`Sản phẩm ${productId} không tồn tại trên S3`);
    } else if (product.status && product.status !== 'active') {
      problems.push(`Sản phẩm ${productId} đang ở trạng thái "${product.status}"`);
    }
  }
  return problems;
}

/**
 * Snapshot the on-hand quantity of each inventory-tracked product on the invoice.
 * Stock is the only externally visible proof that Save/v2 really saved something, so a
 * decrease after the call is treated as evidence and the absence of one as doubt.
 */
export function pickStockSnapshot(items = [], catalog) {
  if (!catalog) return null;
  const snapshot = new Map();
  for (const line of items) {
    const productId = Number(line?.YS_ProductID);
    const product = catalog.get(productId);
    if (!product || !product.inventory) continue;
    snapshot.set(productId, product.quantityOnHand);
  }
  return snapshot.size ? snapshot : null;
}

/**
 * True when any tracked product now holds less stock than the snapshot.
 * Only a decrease counts: S3 deducts stock when it saves an invoice, so identical
 * numbers mean the invoice was not saved (or the branch tracks no stock at all).
 */
export function stockDropped(snapshot, catalog) {
  if (!snapshot || !catalog) return false;
  for (const [productId, before] of snapshot) {
    const after = catalog.get(productId)?.quantityOnHand;
    if (Number.isFinite(after) && after < before) return true;
  }
  return false;
}

/**
 * Issue the sales invoice for a delivered order. Deducts stock once and raises the
 * e-invoice through whatever provider the branch has enabled in S3.
 * Never throws: the caller decides how to record an uncertain outcome.
 */
export async function issueInvoiceToS3({ orderId, order, env = {}, timeoutMs = 8000, fetchFn = fetch, verify = true }) {
  const config = getS3Config(env);
  if (!config.enabled) {
    return { success: false, skipped: true, reason: 's3_sync_disabled', s3InvoiceStatus: 'disabled' };
  }

  const normalizedOrder = { ...order, id: orderId || order.id || order.orderId };
  let dispatched = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const timedFetch = (url, options = {}) => fetchFn(url, { ...options, signal: controller.signal });

  try {
    // Validate product mappings before authenticating or creating a customer.
    // CustomerId only exists after syncCustomerToS3, so use a placeholder here.
    mapOrderToS3InvoicePayload(normalizedOrder, config, 1);
    const token = await getOrRefreshToken(config, timedFetch);
    const customerId = await syncCustomerToS3({
      customer: normalizedOrder.customer,
      token,
      config,
      fetchFn: timedFetch
    });

    const payload = mapOrderToS3InvoicePayload(normalizedOrder, config, customerId);
    const baseUrl = (config.baseUrl || 'https://m.es3.vn').replace(/\/+$/, '');

    // Pre-flight: read the branch catalog and refuse to post an invoice S3 would drop.
    // Save/v2 answers code "00" for an impossible payload, so without this check the
    // order would be recorded as invoiced while no invoice and no stock movement exist.
    let catalog = null;
    let stockBefore = null;
    if (verify) {
      catalog = await fetchS3ProductCatalog({ token, config, fetchFn: timedFetch });
      const lineProblems = findInvoiceLineProblems(payload.Items, catalog);
      if (lineProblems.length) {
        const problemMsg = lineProblems.join('; ');
        console.warn(`[S3 Invoice Pre-flight] Order #${normalizedOrder.id}:`, problemMsg);
        return {
          success: false,
          s3InvoiceStatus: 'needs_review',
          needsReview: true,
          error: `Không gửi được hoá đơn: ${problemMsg}`
        };
      }
      stockBefore = pickStockSnapshot(payload.Items, catalog);

      // Stock check: S3 deducts branch stock when the invoice saves, so selling more than
      // the branch holds is either dropped or leaves a negative balance. An unreadable
      // inventory is treated as unknown (skipped) rather than as a shortage.
      const inventory = await fetchS3Inventory({ token, config, fetchFn: timedFetch });
      const shortages = findStockShortages(payload.Items, inventory);
      if (shortages.length) {
        const shortageMsg = shortages
          .map(s => `${s.name || s.productId} chỉ còn ${s.available}, cần ${s.requested}`)
          .join('; ');
        console.warn(`[S3 Invoice Stock] Order #${normalizedOrder.id}:`, shortageMsg);
        return {
          success: false,
          s3InvoiceStatus: 'needs_review',
          needsReview: true,
          error: `Không đủ tồn kho trên S3: ${shortageMsg}`
        };
      }
      // An empty inventory while the catalog is populated means the read scope is wrong,
      // not that the branch stocks nothing. Recording it as "unknown" prevents an empty
      // response from silently disabling every stock guard from then on.
      if (inventory && inventory.size === 0 && catalog && catalog.size > 0) {
        console.warn(`[S3 Invoice Stock] Order #${normalizedOrder.id}: đọc được danh mục ${catalog.size} sản phẩm nhưng tồn kho chi nhánh rỗng — bỏ qua kiểm tồn.`);
      }
    }

    controller.signal.throwIfAborted();
    dispatched = true;
    const response = await timedFetch(`${baseUrl}/Vision/Invoices/Save/v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json().catch(() => ({}));

    if (response.ok && (responseData.code === '00' || responseData.code === 0 || responseData.success)) {
      // Callers that opt out of verification accept code "00" at face value.
      if (!verify) {
        return {
          success: true,
          s3InvoiceStatus: 'issued',
          s3InvoiceRequestId: payload.RequestId,
          s3CustomerId: customerId || undefined,
          issuedAt: new Date().toISOString()
        };
      }

      // Code "00" only acknowledges receipt. Confirm the invoice exists before telling
      // the order it was issued, otherwise a silently dropped sale looks successful.
      const afterCatalog = await fetchS3ProductCatalog({ token, config, fetchFn: timedFetch });
      const dropConfirmed = stockBefore ? stockDropped(stockBefore, afterCatalog) : false;

      if (dropConfirmed) {
        return {
          success: true,
          s3InvoiceStatus: 'issued',
          s3InvoiceRequestId: payload.RequestId,
          s3CustomerId: customerId || undefined,
          issuedAt: new Date().toISOString(),
          verified: true
        };
      }

      // Nothing proved the invoice exists: the catalog was unreadable, the branch does
      // not track stock for these products, or the invoice really was dropped. Code
      // "00" cannot tell those apart, so the order must be reviewed instead of being
      // reported as issued — that false success is what lost the walk-in invoices.
      const reason = !afterCatalog
        ? 'S3 trả về "00" nhưng không đọc lại được tồn kho để xác nhận hoá đơn.'
        : 'S3 trả về "00" nhưng tồn kho không thay đổi nên chưa xác nhận được hoá đơn đã lưu.';
      console.warn(`[S3 Invoice Unverified] Order #${normalizedOrder.id}:`, reason);
      return {
        success: false,
        s3InvoiceStatus: 'needs_review',
        needsReview: true,
        s3InvoiceRequestId: payload.RequestId,
        error: reason
      };
    }

    // A duplicate RequestId means this order already holds an invoice on S3, so the
    // outcome is known and stock was deducted exactly once. Reporting it as ambiguous
    // would block the order forever and demand a manual reconciliation that can only
    // ever conclude "already invoiced".
    if (response.ok && isDuplicateRequestId(responseData)) {
      return {
        success: true,
        alreadyInvoiced: true,
        s3InvoiceStatus: 'issued',
        s3InvoiceRequestId: payload.RequestId,
        s3CustomerId: customerId || undefined,
        issuedAt: new Date().toISOString()
      };
    }

    const errorMsg = responseData.message || responseData.Message || `HTTP ${response.status}`;
    console.warn(`[S3 Invoice Warning] Order #${normalizedOrder.id}:`, errorMsg);
    return { success: false, s3InvoiceStatus: 'needs_review', needsReview: true, error: errorMsg };
  } catch (error) {
    const isTimeout = error.name === 'AbortError' || error.message?.includes('aborted');
    const errorMsg = isTimeout ? `S3 API request timed out (> ${Math.round(timeoutMs / 1000)}s)` : (error.message || 'Unknown S3 network error');
    console.warn(`[S3 Invoice Fail-Safe] Order #${normalizedOrder.id}:`, errorMsg);
    // Nothing reached S3, but the order still needs attention: parking it as
    // 'pending' would silently strand it with no error recorded anywhere.
    return {
      success: false,
      s3InvoiceStatus: dispatched ? 'needs_review' : 'failed',
      needsReview: true,
      error: errorMsg
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Send order to S3 POS API with strict fail-safe resilience
 * Never throws an unhandled error so customer checkout is NEVER interrupted.
 */
export async function syncOrderToS3({ orderId, order, env = {}, timeoutMs = 4000, fetchFn = fetch }) {
  const config = getS3Config(env);

  if (!config.enabled) {
    return {
      success: false,
      skipped: true,
      reason: 's3_sync_disabled',
      s3SyncStatus: 'disabled'
    };
  }

  const normalizedOrder = {
    ...order,
    id: orderId || order.id || order.orderId
  };
  let dispatched = false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const timedFetch = (url, options = {}) => fetchFn(url, { ...options, signal: controller.signal });
  try {
    // Validate all product mappings before authenticating or creating a customer.
    // CustomerId only exists after syncCustomerToS3, so use a placeholder here.
    mapOrderToS3Payload(normalizedOrder, config, 1);
    const token = await getOrRefreshToken(config, timedFetch);

    // Sync or create customer profile on S3
    const customerId = await syncCustomerToS3({
      customer: normalizedOrder.customer,
      token,
      config,
      fetchFn: timedFetch
    });

    const payload = mapOrderToS3Payload(normalizedOrder, config, customerId);
    const baseUrl = (config.baseUrl || 'https://m.es3.vn').replace(/\/+$/, '');
    const postUrl = `${baseUrl}/Vision/AddNewPreOrder/v2`;

    controller.signal.throwIfAborted();
    dispatched = true;
    const response = await timedFetch(postUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });

    const responseData = await response.json().catch(() => ({}));

    if (response.ok && (responseData.success || responseData.code === '00' || responseData.code === 0)) {
      // AddNewPreOrder/v2 documents only `message` and `code` in its response: there is no
      // PreOrderID to store. RequestId is *our* string, so calling it s3OrderId and showing
      // it as "Đã đồng bộ (#SKINID-...)" claims an S3 identifier that does not exist.
      // Keep it as the request reference it is, and say plainly that S3 returned no id.
      const returnedId = Number(responseData.PreOrderID ?? responseData.YS_PreOrderID ?? 0);
      return {
        success: true,
        ...(Number.isSafeInteger(returnedId) && returnedId > 0
          ? { s3OrderId: String(returnedId) }
          : { s3OrderIdUnknown: true }),
        s3RequestId: String(payload.RequestId),
        s3CustomerId: customerId || undefined,
        s3SyncStatus: 'synced',
        syncedAt: new Date().toISOString(),
        needsReview: false
      };
    }

    const errorMsg = responseData.message || responseData.Message || `HTTP ${response.status}`;
    // RequestId is derived from the order id, so "Lỗi trùng requestId" proves this exact
    // preorder already exists on S3. Treating it as ambiguous would strand the order.
    if (response.ok && isDuplicateRequestId(responseData)) {
      return {
        success: true,
        alreadySynced: true,
        s3OrderId: String(payload.RequestId),
        s3CustomerId: customerId || undefined,
        s3SyncStatus: 'synced',
        syncedAt: new Date().toISOString(),
        needsReview: false
      };
    }

    console.warn(`[S3 Sync Warning] Order #${normalizedOrder.id} failed to sync to S3:`, errorMsg);

    return {
      success: false,
      s3SyncStatus: 'needs_review',
      needsReview: true,
      error: errorMsg,
    };
  } catch (error) {
    const isTimeout = error.name === 'AbortError' || error.message?.includes('aborted');
    const errorMsg = isTimeout ? 'S3 API request timed out (> 4s)' : (error.message || 'Unknown S3 network error');
    console.warn(`[S3 Sync Fail-Safe] Order #${normalizedOrder.id}:`, errorMsg);

    return {
      success: false,
      s3SyncStatus: dispatched ? 'needs_review' : 'pending',
      needsReview: dispatched,
      error: errorMsg
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
