import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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

function createTestContext(overrides = {}) {
  const dbStore = new Map();

  const context = {
    ApiError,
    SERVER_CATALOG: [],
    crypto: webcrypto,
    TextEncoder,
    console,
    isValidFirebasePrivateKey: () => true,
    getDocument: async (_, path) => {
      if (overrides.getDocument) return overrides.getDocument(path);
      return dbStore.get(path) || null;
    },
    listDocuments: async (_, coll) => {
      if (overrides.listDocuments) return overrides.listDocuments(coll);
      const results = [];
      for (const [key, val] of dbStore.entries()) {
        if (key.startsWith(`${coll}/`)) {
          results.push({ id: key.replace(`${coll}/`, ''), ...val });
        }
      }
      return results;
    },
    commitWrites: async (_, writes) => {
      if (overrides.commitWrites) return overrides.commitWrites(writes);
      for (const w of writes) {
        if (w.update && w.update.name) {
          const match = w.update.name.match(/documents\/(.+)$/);
          if (match) {
            const current = dbStore.get(match[1]) || {};
            dbStore.set(match[1], { ...current, ...w.update.fields });
          }
        }
      }
    },
    setFirebaseCustomUserClaims: async (_, uid, claims) => {
      if (overrides.setFirebaseCustomUserClaims) return overrides.setFirebaseCustomUserClaims(uid, claims);
      return { success: true, uid, claims };
    },
    encodeFields: value => value,
    documentName: (_, path) => `projects/test/databases/(default)/documents/${path}`,
    json: (_, __, body, status = 200) => ({ body, status }),
    syncOrderToS3: async () => ({ success: true, s3OrderId: 'S3-MOCK-123', s3SyncStatus: 'synced' }),
    // S3 stays off in the RBAC tests; the stock guard and restock bookkeeping are inert.
    getS3Config: () => ({ enabled: false, branchId: 9099 }),
    fetchS3Inventory: async () => null,
    findStockShortages: () => [],
    buildRestockLines: () => [],
    sendTelegramOrderNotification: async () => true,
    ...overrides
  };

  vm.createContext(context);
  vm.runInContext(workerCode, context);
  return { context, dbStore };
}

test('GD3: Phân quyền 7 vai trò chuẩn và chặn đứng quyền trái phép', async () => {
  const { context } = createTestContext();
  const env = { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test' };

  // 1. Kiểm tra danh sách 7 vai trò chuẩn
  assert.ok(context.VALID_ROLES.includes('super_admin'));
  assert.ok(context.VALID_ROLES.includes('admin'));
  assert.ok(context.VALID_ROLES.includes('editor'));
  assert.ok(context.VALID_ROLES.includes('marketing'));
  assert.ok(context.VALID_ROLES.includes('sales'));
  assert.ok(context.VALID_ROLES.includes('dermatologist'));
  assert.ok(context.VALID_ROLES.includes('warehouse'));

  // 2. Chặn non-super-admin gán vai trò
  const regularAdmin = { sub: 'admin_1', role: 'admin', email: 'admin1@skinid.vn' };
  const assignReq = {
    json: async () => ({ uid: 'user_target', role: 'editor' })
  };

  await assert.rejects(
    async () => context.assignStaffRole(assignReq, env, regularAdmin),
    err => err.code === 'permission_denied' && err.status === 403
  );

  // 3. Super Admin gán vai trò thành công
  const superAdmin = { sub: 'sa_1', role: 'super_admin', email: 'admin@skinid.vn' };
  const validAssignReq = {
    json: async () => ({ uid: 'user_target', role: 'editor' })
  };

  const res = await context.assignStaffRole(validAssignReq, env, superAdmin);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.role, 'editor');

  // 4. Từ chối vai trò bất hợp lệ
  const invalidRoleReq = {
    json: async () => ({ uid: 'user_target', role: 'hacker_role' })
  };
  await assert.rejects(
    async () => context.assignStaffRole(invalidRoleReq, env, superAdmin),
    err => err.code === 'invalid_role' && err.status === 400
  );
});

test('GD3: Audit Log ghi vết đầy đủ khi gán quyền và chuyển trạng thái đơn hàng', async () => {
  const { context, dbStore } = createTestContext();
  const env = { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test' };
  const superAdmin = { sub: 'sa_1', role: 'super_admin', email: 'admin@skinid.vn' };

  // Gán vai trò cho nhân viên
  await context.assignStaffRole({
    json: async () => ({ uid: 'staff_1', role: 'warehouse' })
  }, env, superAdmin);

  // Kiểm tra nhật ký hệ thống
  const logsRes = await context.listAuditLogs({}, env, superAdmin);
  assert.equal(logsRes.status, 200);
  assert.ok(logsRes.body.logs.length >= 1);
  const assignLog = logsRes.body.logs.find(l => l.action === 'assign_role');
  assert.ok(assignLog);
  assert.equal(assignLog.actorRole, 'super_admin');
  assert.equal(assignLog.resource, 'staff');
  assert.equal(assignLog.resourceId, 'staff_1');
  assert.equal(assignLog.details.assignedRole, 'warehouse');
});

test('GD3: Cập nhật thanh toán phải qua worker để có audit log và cờ đối soát S3', async () => {
  const { context, dbStore } = createTestContext();
  const env = { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test' };
  const admin = { sub: 'ad_1', role: 'admin', email: 'admin@skinid.vn' };

  // Đơn chuyển khoản đã xuất hoá đơn nhưng chưa thu tiền: đây đúng là ca mà S3 đã ghi
  // CustomerReceived = 0, nên khi admin xác nhận đã thu tiền thì S3 phải được đối soát tay.
  dbStore.set('orders/ord_bank', {
    id: 'ord_bank',
    status: 'completed',
    paymentMethod: 'bank_transfer',
    paymentStatus: 'pending_transfer',
    s3InvoiceStatus: 'issued',
    s3RestockRequired: false
  });

  const res = await context.updateOrderPaymentStatus(
    { json: async () => ({ paymentStatus: 'paid', note: 'Đã nhận chuyển khoản' }) },
    env,
    admin,
    'ord_bank'
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.previousPaymentStatus, 'pending_transfer');
  assert.equal(res.body.paymentStatus, 'paid');
  assert.equal(res.body.s3ReconcileRequired, true, 'hoá đơn đã xuất thì phải cờ đối soát S3');

  // Ghi vào Firestore đúng các trường, không chỉ trả về trong response.
  const stored = dbStore.get('orders/ord_bank');
  assert.equal(stored.paymentStatus, 'paid');
  assert.equal(stored.s3PaymentReconcileRequired, true);
  assert.equal(stored.s3PaymentReconcileFrom, 'pending_transfer');
  assert.equal(stored.s3PaymentReconcileTo, 'paid');
  assert.equal(stored.paymentHistory.length, 1);
  assert.equal(stored.paymentHistory[0].from, 'pending_transfer');
  assert.equal(stored.paymentHistory[0].to, 'paid');
  assert.equal(stored.paymentHistory[0].changedBy, 'admin@skinid.vn');

  // Tiền là tiền: phải có vết kiểm toán, đây chính là thứ mà ghi thẳng Firestore đánh mất.
  const logsRes = await context.listAuditLogs({}, env, { sub: 'sa_1', role: 'super_admin' });
  const paymentLog = logsRes.body.logs.find(l => l.action === 'order_payment_status');
  assert.ok(paymentLog, 'phải có audit log cho thay đổi thanh toán');
  assert.equal(paymentLog.resourceId, 'ord_bank');
  assert.equal(paymentLog.actorEmail, 'admin@skinid.vn');
  assert.equal(paymentLog.details.fromStatus, 'pending_transfer');
  assert.equal(paymentLog.details.toStatus, 'paid');
});

test('GD3: Cập nhật thanh toán chặn giá trị rác, chặn hoàn tiền đơn chưa thu tiền', async () => {
  const { context, dbStore } = createTestContext();
  const env = { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test' };
  const admin = { sub: 'ad_1', role: 'admin', email: 'admin@skinid.vn' };
  const sales = { sub: 'sl_1', role: 'sales', email: 'sales@skinid.vn' };

  dbStore.set('orders/ord_unpaid', { id: 'ord_unpaid', status: 'confirmed', paymentStatus: 'unpaid' });

  // Giá trị không nằm trong danh sách trắng thì không được ghi vào tiền của đơn.
  await assert.rejects(
    async () => context.updateOrderPaymentStatus(
      { json: async () => ({ paymentStatus: 'da_chuyen_khoan_roi' }) }, env, admin, 'ord_unpaid'
    ),
    err => err.code === 'invalid_payment_status' && err.status === 400
  );

  // Hoàn tiền cho đơn chưa thu được đồng nào sẽ đẩy báo cáo doanh thu thành số ảo.
  await assert.rejects(
    async () => context.updateOrderPaymentStatus(
      { json: async () => ({ paymentStatus: 'refunded' }) }, env, admin, 'ord_unpaid'
    ),
    err => err.code === 'refund_without_payment' && err.status === 409
  );

  // Khách hàng không được đụng vào trạng thái thanh toán.
  await assert.rejects(
    async () => context.updateOrderPaymentStatus(
      { json: async () => ({ paymentStatus: 'paid' }) }, env,
      { sub: 'cus_1', role: 'customer', email: 'khach@gmail.com' }, 'ord_unpaid'
    ),
    err => err.status === 403
  );

  // Đơn không tồn tại phải là 404, không im lặng tạo mới.
  await assert.rejects(
    async () => context.updateOrderPaymentStatus(
      { json: async () => ({ paymentStatus: 'paid' }) }, env, admin, 'ord_khong_ton_tai'
    ),
    err => err.status === 404
  );

  // Sales được phép thu tiền (đúng nghiệp vụ), và đơn chưa xuất hoá đơn thì không cần đối soát S3.
  const okRes = await context.updateOrderPaymentStatus(
    { json: async () => ({ paymentStatus: 'paid' }) }, env, sales, 'ord_unpaid'
  );
  assert.equal(okRes.body.success, true);
  assert.equal(okRes.body.s3ReconcileRequired, false);
  assert.equal(dbStore.get('orders/ord_unpaid').paymentStatus, 'paid');
});

test('GD3: Endpoint thanh toán phải được đăng ký route, không chỉ định nghĩa hàm', () => {
  // Hàm có thể tồn tại mà quên nối route thì client gọi /payment sẽ rơi vào 404 not_found.
  assert.ok(
    workerCode.includes('/payment$/'),
    'route POST /api/admin/orders/:id/payment phải được đăng ký trong handleApi'
  );
  assert.ok(workerCode.includes('updateOrderPaymentStatus(request, env, user'));
});

test('GD3: Quản trị danh sách nhân sự (Staff Directory) lọc bỏ khách hàng thông thường', async () => {
  const { context, dbStore } = createTestContext();
  const env = { FIREBASE_PROJECT_ID: 'test', FIREBASE_CLIENT_EMAIL: 'test', FIREBASE_PRIVATE_KEY: 'test' };
  const superAdmin = { sub: 'sa_1', role: 'super_admin', email: 'admin@skinid.vn' };

  // Pre-seed users
  dbStore.set('users/u1', { id: 'u1', email: 'bs.lan@skinid.vn', name: 'BS. Lan', role: 'dermatologist' });
  dbStore.set('users/u2', { id: 'u2', email: 'kho.hung@skinid.vn', name: 'Kho Hùng', role: 'warehouse' });
  dbStore.set('users/u3', { id: 'u3', email: 'khachhang@gmail.com', name: 'Khách lẻ', role: 'customer' });

  const res = await context.listStaff({}, env, superAdmin);
  assert.equal(res.status, 200);
  const staff = res.body.staff;
  assert.ok(staff.some(s => s.role === 'dermatologist'));
  assert.ok(staff.some(s => s.role === 'warehouse'));
  assert.ok(!staff.some(s => s.email === 'khachhang@gmail.com'), 'Khách hàng thông thường không được xuất hiện trong danh sách nhân sự');
});
