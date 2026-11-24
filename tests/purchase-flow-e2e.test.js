// Full storefront purchase flow, driven through the worker's real HTTP router.
//
// Every request below goes through `worker.fetch` -> `handleApi`, so the assertions cover
// the same code path production uses: Firebase token check, server-side repricing, the
// S3 outbox invoice, the money endpoint and the status machine. Firestore is an in-memory
// map and S3 is stubbed, so nothing here can touch the live shop or the real POS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { findStockShortages, buildRestockLines } from '../worker/services/s3Service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const workerCode = readFileSync(resolve(root, 'worker/index.js'), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';?\r?\n/gm, '')
  .replace('export default {', 'const workerDefault = {')
  .replace(/^export /gm, '');

const SERVER_CATALOG = [
  { id: 'rilastil-525', productCode: 'RIL525', s3ProductId: 1808964, name: 'Kem dưỡng ẩm Rilastil', price: 450000, volume: '50ml' },
  { id: 'rilastil-2067', productCode: 'RIL2067', s3ProductId: 1808965, name: 'Serum Aqua Rilastil', price: 680000, volume: '30ml' }
];

const ACCOUNTS = {
  'customer-1': { sub: 'customer-1', email: 'khach@skinid.vn', email_verified: true },
  'customer-2': { sub: 'customer-2', email: 'nguoi-khac@skinid.vn', email_verified: true },
  'admin-1': { sub: 'admin-1', email: 'ops@skinid.vn', email_verified: true, role: 'admin', admin: true },
  'sales-1': { sub: 'sales-1', email: 'sales@skinid.vn', email_verified: true, role: 'sales' }
};

const STOCK = new Map([
  [1808964, { tracked: true, quantityOnHand: 50, name: 'Kem dưỡng ẩm Rilastil' }],
  [1808965, { tracked: true, quantityOnHand: 50, name: 'Serum Aqua Rilastil' }]
]);

function createBackend(overrides = {}) {
  const db = new Map();
  const calls = { invoices: [], s3Syncs: [] };

  const commitWrites = async (_, writes) => {
    if (overrides.commitWrites) return overrides.commitWrites(writes);
    for (const write of writes) {
      const path = write.update?.name?.match(/documents\/(.+)$/)?.[1] || write.delete?.match(/documents\/(.+)$/)?.[1];
      if (!path) continue;
      if (write.delete) { db.delete(path); continue; }
      if (write.currentDocument?.exists === false && db.has(path)) {
        throw Object.assign(new Error('ALREADY_EXISTS'), { code: 'write_conflict' });
      }
      db.set(path, { ...(db.get(path) || {}), ...write.update.fields });
    }
  };

  const context = {
    console,
    Response,
    Request,
    Headers,
    URL,
    crypto: webcrypto,
    TextEncoder,
    ApiError,
    SERVER_CATALOG,
    SERVER_ARTICLES: [],
    POLICY_META_MAP: {},
    // A real Response keeps every status code and payload identical to production.
    json: (request, env, body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    }),
    corsHeaders: () => ({}),
    isValidFirebasePrivateKey: () => true,
    requiredFirebaseEnv: () => {},
    // The stock guard passes the global `fetch` into the token refresh; it must exist for
    // the guard to actually run. Inventory itself is injected via fetchS3Inventory below,
    // so any real network call here is a bug and fails loudly.
    fetch: async url => { throw new Error(`Unexpected network call in test: ${url}`); },
    // Production verifies the Firebase ID token signature against Google's JWKS; here the
    // bearer value is the account uid so one test file can drive every role.
    authenticate: async request => {
      const uid = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
      const account = uid && ACCOUNTS[uid];
      if (!account) throw new ApiError(401, 'unauthenticated', 'Bạn cần đăng nhập trước khi thực hiện thao tác này.');
      return account;
    },
    getDocument: async (_, path) => (overrides.getDocument ? overrides.getDocument(path) : db.get(path) || null),
    listDocuments: async (_, collection) => [...db.entries()]
      .filter(([path]) => path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes('/'))
      .map(([path, value]) => ({ id: path.slice(collection.length + 1), ...value })),
    runQuery: async (_, query) => {
      const collection = query.from[0].collectionId;
      const field = query.where?.fieldFilter?.field?.fieldPath;
      const expected = query.where?.fieldFilter?.value?.stringValue;
      return [...db.entries()]
        .filter(([path]) => path.startsWith(`${collection}/`) && !path.slice(collection.length + 1).includes('/'))
        .filter(([, value]) => !field || value[field] === expected)
        .map(([path, value]) => ({ id: path.slice(collection.length + 1), ...value }));
    },
    commitWrites,
    setFirebaseCustomUserClaims: async () => ({ success: true }),
    deleteFirebaseUser: async () => ({ success: true }),
    encodeFields: value => value,
    documentName: (_, path) => `projects/test/databases/(default)/documents/${path}`,
    // ES3 POS stays enabled so the invoice and restock bookkeeping really execute.
    getS3Config: () => ({ enabled: true, branchId: 9099 }),
    getOrRefreshToken: async () => 's3-test-token',
    fetchS3Inventory: async () => new Map([...STOCK].map(([id, value]) => [id, { ...value }])),
    findStockShortages,
    buildRestockLines,
    syncOrderToS3: async ({ orderId }) => {
      calls.s3Syncs.push(orderId);
      return { success: true, s3OrderId: 'PRE-TEST-1', s3SyncStatus: 'synced', syncedAt: new Date().toISOString() };
    },
    dispatchInvoiceS3: async ({ orderId, order }) => {
      calls.invoices.push({ orderId, status: order.status });
      return { success: true, s3InvoiceStatus: 'issued', s3InvoiceRequestId: 'SKINID-INV-TEST', issuedAt: new Date().toISOString() };
    },
    sendTelegramOrderNotification: async () => true,
    ...overrides
  };

  vm.createContext(context);
  vm.runInContext(workerCode, context);
  return {
    // `const workerDefault` is a lexical binding, so it is not a property of the context.
    worker: vm.runInContext('workerDefault', context),
    db,
    calls,
    orderIds: () => [...db.keys()].filter(path => /^orders\/[^/]+$/.test(path)),
    env: { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test' }
  };
}

const BASE = 'https://skinid.vn';

function api(backend, method, path, { uid, body, idempotencyKey } = {}) {
  return backend.worker.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(uid ? { authorization: `Bearer ${uid}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), backend.env);
}

const CUSTOMER = { name: 'Nguyễn Văn Khách', phone: '0912345678' };
const ADDRESS = { line1: '35 đường số 3', wardCode: 26734, wardName: 'Phường Tân Mỹ', provinceCode: 79, provinceName: 'Thành phố Hồ Chí Minh' };

const cartPayload = (extra = {}) => ({
  customer: { ...CUSTOMER, shippingAddress: ADDRESS },
  items: [{ productId: 'rilastil-525', quantity: 2 }],
  note: 'Giao giờ hành chính',
  ...extra
});

async function placeOrder(backend, { uid = 'customer-1', idempotencyKey, ...extra } = {}) {
  const response = await api(backend, 'POST', '/api/orders', { uid, body: cartPayload(extra), idempotencyKey });
  return { response, body: await response.json() };
}

async function transition(backend, orderId, targetStatus, uid = 'admin-1') {
  const response = await api(backend, 'POST', `/api/admin/orders/${orderId}/transition`, {
    uid, body: { targetStatus, note: `Chuyển sang ${targetStatus}` }
  });
  return { response, body: await response.json() };
}

// 1. Chưa đăng nhập thì không có đơn nào được ghi.
test('E2E luồng mua: khách chưa đăng nhập bị chặn trước khi ghi đơn', async () => {
  const backend = createBackend();
  const response = await api(backend, 'POST', '/api/orders', { body: cartPayload() });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'unauthenticated');
  // Nothing is written: the guard runs before the first Firestore commit.
  assert.deepEqual([...backend.db.keys()], []);
});

// 2. Giỏ hàng -> đơn: server tự tính giá, freeship, và idempotency chống đơn trùng.
test('E2E luồng mua: đặt hàng COD dùng giá server, freeship và chống tạo đơn trùng', async () => {
  const backend = createBackend();
  const key = 'idemp_purchase_flow_1';
  const payload = cartPayload();
  // A tampered price from the browser must be ignored completely.
  payload.items = [{ productId: 'rilastil-525', quantity: 2, price: 1, lineTotal: 2 }];

  const created = await api(backend, 'POST', '/api/orders', { uid: 'customer-1', body: payload, idempotencyKey: key });
  const order = await created.json();
  assert.equal(created.status, 201);
  assert.equal(order.success, true);
  assert.equal(order.subtotal, 900000, 'giá lấy từ SERVER_CATALOG, không lấy giá 1đ của client');
  assert.equal(order.discount, 0);
  assert.equal(order.shippingFee, 0, 'mọi đơn hàng đều được miễn phí vận chuyển');
  assert.equal(order.total, 900000);

  const stored = backend.db.get(`orders/${order.orderId}`);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.paymentMethod, 'cod');
  assert.equal(stored.paymentStatus, 'unpaid');
  assert.equal(stored.userId, 'customer-1');
  assert.equal(stored.items[0].lineTotal, 900000);
  assert.equal(stored.s3SyncStatus, 'synced', 'đơn được đẩy sang S3 ngay sau khi lưu');
  assert.equal(stored.customer.shippingAddress.wardName, 'Phường Tân Mỹ');

  // Cart, profile and default address are written in the same commit.
  assert.equal(backend.db.get('users/customer-1').name, 'Nguyễn Văn Khách');
  assert.ok(backend.db.get('users/customer-1/addresses/default'));
  assert.equal(backend.db.get(`users/customer-1/activities/${order.orderId}`).type, 'order_created');

  // A double click or a retried request must not create a second order.
  const retried = await api(backend, 'POST', '/api/orders', { uid: 'customer-1', body: payload, idempotencyKey: key });
  const duplicate = await retried.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.orderId, order.orderId);
  assert.equal(backend.orderIds().length, 1);

  // The order shows up only for its owner.
  const mine = await (await api(backend, 'GET', '/api/orders', { uid: 'customer-1' })).json();
  assert.equal(mine.orders.length, 1);
  assert.equal(mine.orders[0].id, order.orderId);
  const others = await (await api(backend, 'GET', '/api/orders', { uid: 'customer-2' })).json();
  assert.equal(others.orders.length, 0);
});

// 3. Dữ liệu nhận hàng và tồn kho sai bị chặn ở server, không chỉ ở form.
test('E2E luồng mua: server từ chối số điện thoại, địa chỉ và số lượng không hợp lệ', async () => {
  const backend = createBackend();

  const badPhone = await placeOrder(backend, { customer: { ...CUSTOMER, phone: '12345', shippingAddress: ADDRESS } });
  assert.equal(badPhone.response.status, 400);
  assert.equal(badPhone.body.code, 'invalid_phone');

  const badAddress = await placeOrder(backend, { customer: { ...CUSTOMER, shippingAddress: { line1: '35 đường số 3' } } });
  assert.equal(badAddress.response.status, 400);
  assert.equal(badAddress.body.code, 'invalid_address');

  // The worker caps one line at 20 units regardless of what the cart UI allows.
  const tooMany = await placeOrder(backend, { items: [{ productId: 'rilastil-525', quantity: 21 }] });
  assert.equal(tooMany.response.status, 400);
  assert.equal(tooMany.body.code, 'invalid_quantity');

  const unknownProduct = await placeOrder(backend, { items: [{ productId: 'khong-ton-tai', quantity: 1 }] });
  assert.equal(unknownProduct.response.status, 409);
  assert.equal(unknownProduct.body.code, 'product_unavailable');

  assert.equal(backend.orderIds().length, 0);
});

// 4. Chi nhánh hết hàng: chặn trước khi khách trả tiền, thay vì phát hiện lúc giao.
test('E2E luồng mua: chặn đặt hàng khi chi nhánh không đủ tồn kho S3', async () => {
  const backend = createBackend({
    fetchS3Inventory: async () => new Map([[1808964, { tracked: true, quantityOnHand: 1, name: 'Kem dưỡng ẩm Rilastil' }]])
  });

  const { response, body } = await placeOrder(backend);
  assert.equal(response.status, 409);
  assert.equal(body.code, 'insufficient_stock');
  assert.match(body.message, /chỉ còn 1 sản phẩm/);
  assert.equal(backend.orderIds().length, 0, 'không ghi đơn hàng nào khi thiếu tồn kho');
  assert.equal(backend.calls.s3Syncs.length, 0);
});

// 5. Khách không thể tự chạm vào tiền hay trạng thái của đơn.
test('E2E luồng mua: khách không có quyền cập nhật thanh toán hay chuyển trạng thái', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { idempotencyKey: 'idemp_purchase_flow_perm' });
  const orderId = body.orderId;

  const payment = await api(backend, 'POST', `/api/admin/orders/${orderId}/payment`, { uid: 'customer-1', body: { paymentStatus: 'paid' } });
  assert.equal(payment.status, 403);
  assert.equal((await payment.json()).code, 'permission_denied');
  assert.equal(backend.db.get(`orders/${orderId}`).paymentStatus, 'unpaid');

  const status = await api(backend, 'POST', `/api/admin/orders/${orderId}/transition`, { uid: 'customer-1', body: { targetStatus: 'completed' } });
  assert.equal(status.status, 403);
  assert.equal(backend.db.get(`orders/${orderId}`).status, 'pending');

  // Firestore is the real security boundary, so the rule set must also refuse these
  // fields; the worker guard alone would be bypassable from the browser console.
  const rules = readFileSync(resolve(root, 'firestore.rules'), 'utf8');
  const orderBlock = rules.slice(rules.indexOf('match /orders/{orderId}'), rules.indexOf('match /users/{userId}'));
  for (const field of ['paymentStatus', 'paymentHistory', 's3InvoiceStatus', 's3RestockRequired']) {
    assert.ok(orderBlock.includes(`'${field}'`), `firestore.rules phải chặn client ghi ${field}`);
  }
  assert.match(orderBlock, /allow create: if false/);
});

// 6. Toàn bộ vòng đời COD: xác nhận -> giao -> hoàn tất, xuất đúng một hoá đơn S3.
test('E2E luồng mua: đơn COD đi hết pending -> completed và chỉ xuất một hoá đơn S3', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { idempotencyKey: 'idemp_purchase_flow_cod' });
  const orderId = body.orderId;

  for (const targetStatus of ['confirmed', 'shipping', 'completed']) {
    const step = await transition(backend, orderId, targetStatus);
    assert.equal(step.response.status, 200, `${targetStatus}: ${JSON.stringify(step.body)}`);
    assert.equal(step.body.status, targetStatus);
    assert.equal(backend.db.get(`orders/${orderId}`).status, targetStatus);
  }

  const stored = backend.db.get(`orders/${orderId}`);
  assert.equal(stored.statusHistory.map(entry => entry.to).join(','), 'confirmed,shipping,completed');
  assert.equal(stored.statusHistory[0].changedBy, 'ops@skinid.vn');
  assert.equal(stored.s3InvoiceStatus, 'issued');
  assert.equal(stored.s3InvoiceRequestId, 'SKINID-INV-TEST');
  assert.equal(backend.calls.invoices.length, 1, 'hoàn tất chỉ được xuất hoá đơn một lần');
  assert.equal(stored.paymentStatus, 'unpaid', 'COD thu tiền khi giao, không tự đổi trạng thái tiền');

  // Every transition is traceable in the audit log.
  const logs = await (await api(backend, 'GET', '/api/admin/audit-logs', { uid: 'admin-1' })).json();
  const transitions = logs.logs.filter(log => log.action === 'order_transition' && log.resourceId === orderId);
  assert.equal(transitions.length, 3);
  assert.equal(transitions[0].actorRole, 'admin');

  // Skipping a state must be refused by the server, not only hidden in the UI.
  const skipped = await transition(backend, orderId, 'pending');
  assert.equal(skipped.response.status, 400);
  assert.equal(skipped.body.code, 'invalid_transition');

  // A delivered order may still be returned, and that must not raise a second invoice.
  const returned = await transition(backend, orderId, 'returned');
  assert.equal(returned.response.status, 200);
  assert.equal(backend.calls.invoices.length, 1);
});

// 7. Chuyển khoản: chưa xác nhận tiền thì không được hoàn tất để trừ kho S3.
test('E2E luồng mua: đơn chuyển khoản chưa thu tiền không thể hoàn tất', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { paymentMethod: 'bank_transfer', idempotencyKey: 'idemp_purchase_flow_bank' });
  const orderId = body.orderId;

  const order = backend.db.get(`orders/${orderId}`);
  assert.equal(order.paymentMethod, 'bank_transfer');
  assert.equal(order.paymentStatus, 'pending_transfer', 'VietQR chờ khách quét mã');

  for (const targetStatus of ['confirmed', 'shipping']) {
    const step = await transition(backend, orderId, targetStatus);
    assert.equal(step.response.status, 200);
  }

  const blocked = await transition(backend, orderId, 'completed');
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.code, 'payment_not_confirmed');
  assert.equal(backend.calls.invoices.length, 0, 'không được xuất hoá đơn khi tiền chưa về');
  assert.equal(backend.db.get(`orders/${orderId}`).status, 'shipping');

  // Refunding money that never arrived is refused: there is no revenue to give back.
  const refund = await api(backend, 'POST', `/api/admin/orders/${orderId}/payment`, {
    uid: 'admin-1', body: { paymentStatus: 'refunded' }
  });
  assert.equal(refund.status, 409);
  assert.equal((await refund.json()).code, 'refund_without_payment');

  // A garbage payment status is rejected before it can reach Firestore.
  const garbage = await api(backend, 'POST', `/api/admin/orders/${orderId}/payment`, {
    uid: 'admin-1', body: { paymentStatus: 'da_chuyen_khoan_roi' }
  });
  assert.equal(garbage.status, 400);
  assert.equal((await garbage.json()).code, 'invalid_payment_status');
});


// 8. Thu tiền -> hoàn tất -> xuất hoá đơn; sửa tiền sau hoá đơn phải bật cờ đối soát S3.
test('E2E luồng mua: xác nhận chuyển khoản, hoàn tất và đối soát khi sửa tiền sau hoá đơn', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { paymentMethod: 'bank_transfer', idempotencyKey: 'idemp_purchase_flow_paid' });
  const orderId = body.orderId;

  const paid = await api(backend, 'POST', `/api/admin/orders/${orderId}/payment`, {
    uid: 'sales-1', body: { paymentStatus: 'paid', note: 'Đã nhận 900.000đ sao kê Vietcombank' }
  });
  const paidBody = await paid.json();
  assert.equal(paid.status, 200);
  assert.equal(paidBody.previousPaymentStatus, 'pending_transfer');
  assert.equal(paidBody.paymentStatus, 'paid');
  assert.equal(paidBody.s3ReconcileRequired, false, 'hoá đơn chưa xuất nên chưa cần đối soát');

  const afterPay = backend.db.get(`orders/${orderId}`);
  assert.equal(afterPay.paymentHistory.length, 1);
  assert.equal(afterPay.paymentHistory[0].from, 'pending_transfer');
  assert.equal(afterPay.paymentHistory[0].to, 'paid');
  assert.equal(afterPay.paymentHistory[0].changedBy, 'sales@skinid.vn');

  for (const targetStatus of ['confirmed', 'shipping', 'completed']) {
    const step = await transition(backend, orderId, targetStatus);
    assert.equal(step.response.status, 200, `${targetStatus}: ${JSON.stringify(step.body)}`);
  }
  assert.equal(backend.db.get(`orders/${orderId}`).s3InvoiceStatus, 'issued');
  assert.equal(backend.calls.invoices.length, 1);

  // The invoice froze CustomerReceived = 900.000, so a later refund must raise the
  // reconciliation flag instead of letting S3 silently disagree with the books.
  const refund = await api(backend, 'POST', `/api/admin/orders/${orderId}/payment`, {
    uid: 'admin-1', body: { paymentStatus: 'refunded', note: 'Khách trả hàng, hoàn tiền' }
  });
  const refundBody = await refund.json();
  assert.equal(refund.status, 200);
  assert.equal(refundBody.s3ReconcileRequired, true);

  const stored = backend.db.get(`orders/${orderId}`);
  assert.equal(stored.paymentStatus, 'refunded');
  assert.equal(stored.s3PaymentReconcileRequired, true);
  assert.equal(stored.s3PaymentReconcileFrom, 'paid');
  assert.equal(stored.s3PaymentReconcileTo, 'refunded');
  assert.equal(stored.paymentHistory.length, 2);

  const logs = await (await api(backend, 'GET', '/api/admin/audit-logs', { uid: 'admin-1' })).json();
  assert.equal(logs.logs.filter(log => log.action === 'order_payment_status' && log.resourceId === orderId).length, 2);
});

// 9. Trả hàng sau khi xuất hoá đơn: S3 không có API hoàn kho nên phải ghi nghĩa vụ.
test('E2E luồng mua: trả hàng đơn đã xuất hoá đơn ghi lại nghĩa vụ hoàn kho S3', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { idempotencyKey: 'idemp_purchase_flow_return' });
  const orderId = body.orderId;

  for (const targetStatus of ['confirmed', 'shipping', 'completed']) {
    await transition(backend, orderId, targetStatus);
  }
  assert.equal(backend.db.get(`orders/${orderId}`).s3InvoiceStatus, 'issued');

  const returned = await transition(backend, orderId, 'returned');
  assert.equal(returned.response.status, 200);
  assert.equal(returned.body.status, 'returned');
  assert.equal(returned.body.restockRequired, true);
  assert.equal(
    returned.body.restockLines.map(line => `${line.s3ProductId}:${line.name}:${line.quantity}`).join('|'),
    '1808964:Kem dưỡng ẩm Rilastil:2'
  );

  const stored = backend.db.get(`orders/${orderId}`);
  assert.equal(stored.s3RestockRequired, true);
  assert.equal(stored.s3RestockReason, 'returned');
  assert.equal(backend.calls.invoices.length, 1, 'hoàn hàng không được xuất hoá đơn lần hai');
});

// 10. Đơn bị huỷ trước khi giao thì không có hoá đơn, không có nghĩa vụ hoàn kho.
test('E2E luồng mua: huỷ đơn trước khi giao không tạo hoá đơn hay nghĩa vụ hoàn kho', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { idempotencyKey: 'idemp_purchase_flow_cancel' });
  const orderId = body.orderId;

  const cancelled = await transition(backend, orderId, 'cancelled');
  assert.equal(cancelled.response.status, 200);
  assert.equal(backend.calls.invoices.length, 0);

  const stored = backend.db.get(`orders/${orderId}`);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.s3InvoiceStatus, undefined);
  assert.equal(stored.s3RestockRequired, undefined);
});


// 11. Mã giảm giá: server tra Firestore, áp giảm giá và tăng lượt dùng đúng một lần.
test('E2E luồng mua: áp mã giảm giá do server tính và tăng lượt dùng một lần', async () => {
  const backend = createBackend();
  backend.db.set('promotions/SKINID10', {
    code: 'SKINID10', type: 'percent', discountValue: 10, minOrderValue: 500000,
    maxDiscount: 150000, active: true, usedCount: 0, usageLimit: 10
  });

  const ok = await placeOrder(backend, { couponCode: 'skinid10', idempotencyKey: 'idemp_purchase_flow_coupon' });
  assert.equal(ok.response.status, 201);
  assert.equal(ok.body.subtotal, 900000);
  assert.equal(ok.body.discount, 90000, '10% của 900.000đ');
  assert.equal(ok.body.total, 810000, 'freeship nên tổng chỉ trừ giảm giá');

  const stored = backend.db.get(`orders/${ok.body.orderId}`);
  assert.equal(stored.couponCode, 'SKINID10', 'mã được chuẩn hoá thành chữ hoa');
  assert.equal(stored.discountAmount, 90000);
  assert.equal(backend.db.get('promotions/SKINID10').usedCount, 1);

  // Bấm lại "Xác nhận đặt hàng" không được trừ thêm lượt dùng: đơn trùng được trả về sớm
  // trước khi coupon được xử lý lại.
  const retried = await placeOrder(backend, { couponCode: 'skinid10', idempotencyKey: 'idemp_purchase_flow_coupon' });
  assert.equal(retried.body.duplicate, true);
  assert.equal(backend.db.get('promotions/SKINID10').usedCount, 1, 'retry idempotent không tăng lượt dùng');

  // Không tồn tại trong Firestore thì không được rơi về bảng mã demo tĩnh.
  const unknown = await placeOrder(backend, { couponCode: 'KHONGCÓ' });
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.body.code, 'invalid_coupon');

  // Mã đã hết lượt dùng phải bị chặn, không chỉ bị ẩn trên UI.
  backend.db.set('promotions/HETLUOT', {
    code: 'HETLUOT', type: 'fixed', discountValue: 50000, minOrderValue: 0,
    active: true, usedCount: 10, usageLimit: 10
  });
  const exhausted = await placeOrder(backend, { couponCode: 'HETLUOT' });
  assert.equal(exhausted.response.status, 400);
  assert.equal(exhausted.body.code, 'coupon_limit_exceeded');

  // Đơn dưới mức tối thiểu cũng bị chặn.
  const belowMin = await placeOrder(backend, { items: [{ productId: 'rilastil-525', quantity: 1 }], couponCode: 'SKINID10' });
  assert.equal(belowMin.response.status, 400);
  assert.equal(belowMin.body.code, 'coupon_min_order');
});

// 12. Khách tự huỷ đơn của mình qua PATCH /api/orders/:id, không huỷ được đơn người khác.
test('E2E luồng mua: khách tự huỷ đơn đang chờ và không huỷ được đơn của người khác', async () => {
  const backend = createBackend();
  const { body } = await placeOrder(backend, { idempotencyKey: 'idemp_purchase_flow_selfcancel' });
  const orderId = body.orderId;

  const notMine = await api(backend, 'PATCH', `/api/orders/${orderId}`, { uid: 'customer-2', body: {} });
  assert.equal(notMine.status, 404, 'không tiết lộ đơn của người khác');
  assert.equal(backend.db.get(`orders/${orderId}`).status, 'pending');

  const cancelled = await api(backend, 'PATCH', `/api/orders/${orderId}`, { uid: 'customer-1', body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(backend.db.get(`orders/${orderId}`).status, 'cancelled');
  assert.equal(backend.calls.invoices.length, 0);

  // Giao rồi thì khách không tự huỷ được nữa; phải qua quy trình trả hàng của admin.
  const second = await placeOrder(backend, { idempotencyKey: 'idemp_purchase_flow_selfcancel2' });
  for (const targetStatus of ['confirmed', 'shipping']) {
    await transition(backend, second.body.orderId, targetStatus);
  }
  const tooLate = await api(backend, 'PATCH', `/api/orders/${second.body.orderId}`, { uid: 'customer-1', body: {} });
  assert.equal(tooLate.status, 409);
  assert.equal((await tooLate.json()).code, 'order_not_cancellable');
});
