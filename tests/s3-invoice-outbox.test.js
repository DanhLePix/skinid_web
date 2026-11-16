import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const workerCode = readFileSync(resolve(root, 'worker/index.js'), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '')
  .replace('export default {', 'const workerDefault = {')
  .replace(/^export /gm, '');

const env = { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test', S3_USERNAME: 'u', S3_PASSWORD: 'p', S3_SYNC_ENABLED: 'true' };
const adminUser = { sub: 'admin_1', admin: true, email: 'admin@skinid.vn' };

function memoryOutbox() {
  let record;
  let version = 0;
  const stamp = () => `v${version}`;
  return {
    get: async () => (record ? { ...record, _updateTime: stamp() } : null),
    put: async (value, expectedVersion) => {
      if (expectedVersion ? expectedVersion !== stamp() : Boolean(record)) throw new Error('conflict');
      version += 1;
      record = value;
    },
    finish: async value => { version += 1; record = value; }
  };
}

test('invoice outbox issues exactly one S3 invoice for concurrent completions', async () => {
  const { dispatchInvoiceS3 } = await import('../worker/services/s3Dispatch.js');
  const store = memoryOutbox();
  let sends = 0;
  let stockDeductions = 0;
  const send = async () => {
    sends++;
    stockDeductions += 1; // one saved invoice == one stock deduction on S3
    return { success: true, s3InvoiceStatus: 'issued', s3InvoiceRequestId: 'SKINID-INV-1' };
  };
  const args = { orderId: 'order-inv-1', order: { total: 1000 }, env, store, send };

  const results = await Promise.all([dispatchInvoiceS3(args), dispatchInvoiceS3(args)]);
  assert.equal(sends, 1);
  assert.equal(stockDeductions, 1);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.filter(r => !r.success && r.s3InvoiceStatus === 'needs_review').length, 1);

  // A finished invoice is never sent again, even when an admin clicks the button.
  const repeated = await dispatchInvoiceS3(args);
  assert.equal(repeated.alreadyInvoiced, true);
  assert.equal(sends, 1);
});

test('ambiguous invoice stays blocked until an admin reconciles S3', async () => {
  const { dispatchInvoiceS3 } = await import('../worker/services/s3Dispatch.js');
  const store = memoryOutbox();
  let sends = 0;
  const send = async () => { sends++; return { success: false, s3InvoiceStatus: 'needs_review', needsReview: true, error: 'HTTP 500' }; };

  await dispatchInvoiceS3({ orderId: 'order-inv-2', order: {}, env, store, send });
  const blocked = await dispatchInvoiceS3({ orderId: 'order-inv-2', order: {}, env, store, send });
  assert.equal(sends, 1);
  assert.equal(blocked.needsReview, true);

  // Only an explicit reconciliation may retry: it is the admin's written confirmation
  // that S3 does not already hold an invoice for this order.
  const forced = await dispatchInvoiceS3({ orderId: 'order-inv-2', order: {}, env, store, send, force: true });
  assert.equal(sends, 2);
  assert.equal(forced.success, false);
});

function createTestContext(overrides = {}) {
  const dbStore = new Map();
  const calls = { invoices: [] };
  const context = {
    ApiError,
    SERVER_CATALOG: [],
    SERVER_ARTICLES: [],
    POLICY_META_MAP: {},
    crypto: webcrypto,
    TextEncoder,
    console,
    isValidFirebasePrivateKey: () => true,
    getS3Config: () => ({ enabled: true }),
    dispatchInvoiceS3: async args => {
      calls.invoices.push({ orderId: args.orderId, force: args.force === true });
      // Mirrors the real outbox: an ambiguous invoice stays blocked until forced.
      if (overrides.invoiceNeedsReview && !args.force) {
        return { success: false, s3InvoiceStatus: 'needs_review', needsReview: true, error: 'Đang chờ đối soát.' };
      }
      return { success: true, s3InvoiceStatus: 'issued', s3InvoiceRequestId: 'SKINID-INV-TEST', issuedAt: new Date().toISOString() };
    },
    syncOrderToS3: async () => ({ success: true, s3SyncStatus: 'synced', s3OrderId: 'S3-1' }),
    // Invoice-outbox tests never reach S3 inventory; the guard and restock stay inert.
    fetchS3Inventory: async () => null,
    findStockShortages: () => [],
    buildRestockLines: () => [],
    getDocument: async (_, path) => {
      if (overrides.docs && Object.prototype.hasOwnProperty.call(overrides.docs, path)) return { ...overrides.docs[path] };
      return dbStore.get(path) || null;
    },
    commitWrites: async (_, writes) => {
      for (const w of writes) {
        if (!w.update?.name) continue;
        const match = w.update.name.match(/documents\/(.+)$/);
        if (match) dbStore.set(match[1], { ...(dbStore.get(match[1]) || {}), ...w.update.fields });
      }
    },
    encodeFields: value => value,
    documentName: (_, path) => `projects/test/databases/(default)/documents/${path}`,
    json: (_, __, body, status = 200) => ({ body, status }),
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(workerCode, context);
  return { context, dbStore, calls };
}

test('completing an unpaid bank transfer is rejected before any S3 invoice', async () => {
  const order = {
    id: 'ord_bank',
    userId: 'user_1',
    status: 'shipping',
    paymentMethod: 'bank_transfer',
    paymentStatus: 'pending_transfer',
    total: 500000,
    items: [{ s3ProductId: 101, quantity: 1, price: 500000 }]
  };
  const { context, calls } = createTestContext({
    docs: { 'orders/ord_bank': order }
  });

  await assert.rejects(
    () => context.transitionOrderStatus({ json: async () => ({ targetStatus: 'completed' }) }, env, adminUser, 'ord_bank'),
    err => err.code === 'payment_not_confirmed'
  );
  assert.equal(calls.invoices.length, 0);
});

test('completing a paid bank transfer issues the invoice through the guarded outbox', async () => {
  const order = {
    id: 'ord_bank_paid',
    userId: 'user_1',
    status: 'shipping',
    paymentMethod: 'bank_transfer',
    paymentStatus: 'paid',
    total: 500000,
    items: [{ s3ProductId: 101, quantity: 1, price: 500000 }]
  };
  const { context, dbStore, calls } = createTestContext({
    docs: { 'orders/ord_bank_paid': order }
  });

  const res = await context.transitionOrderStatus({ json: async () => ({ targetStatus: 'completed' }) }, env, adminUser, 'ord_bank_paid');
  assert.equal(res.body.status, 'completed');
  assert.equal(calls.invoices.length, 1);
  const saved = dbStore.get('orders/ord_bank_paid');
  assert.equal(saved.s3InvoiceStatus, 'issued');
  assert.equal(saved.s3InvoiceRequestId, 'SKINID-INV-TEST');
});

test('issue-invoice endpoint refuses non-completed orders and honours reconciliation confirmation', async () => {
  const base = {
    id: 'ord_retry',
    userId: 'user_1',
    status: 'completed',
    s3InvoiceStatus: 'needs_review',
    s3InvoiceError: 'HTTP 500',
    paymentMethod: 'cod',
    total: 500000,
    items: [{ s3ProductId: 101, quantity: 1, price: 500000 }]
  };
  const { context, dbStore, calls } = createTestContext({
    invoiceNeedsReview: true,
    docs: {
      'orders/ord_retry': base,
      'orders/ord_shipping': { ...base, id: 'ord_shipping', status: 'shipping' }
    }
  });

  await assert.rejects(
    () => context.reissueInvoiceForOrder({ json: async () => ({}) }, env, adminUser, 'ord_shipping'),
    err => err.code === 'order_not_completed'
  );
  assert.equal(calls.invoices.length, 0);

  // Without confirmation the worker refuses, so a human must check S3 first.
  const refused = await context.reissueInvoiceForOrder({ json: async () => ({}) }, env, adminUser, 'ord_retry');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.success, false);
  assert.equal(calls.invoices.at(-1).force, false);
  assert.equal(dbStore.get('orders/ord_retry').s3InvoiceStatus, 'needs_review');

  const retried = await context.reissueInvoiceForOrder({ json: async () => ({ reconcileConfirmed: true }) }, env, adminUser, 'ord_retry');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.success, true);
  assert.equal(calls.invoices.at(-1).force, true);
  assert.equal(dbStore.get('orders/ord_retry').s3InvoiceStatus, 'issued');
});
