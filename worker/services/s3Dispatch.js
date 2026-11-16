import { commitWrites, documentName, encodeFields, getDocument } from '../firestore.js';
import { getS3Config, requiredFirebaseEnv } from '../app/env.js';
import { syncOrderToS3 as sendToPos, issueInvoiceToS3 as sendInvoiceToPos } from './s3Service.js';

// Durable dispatch record prevents concurrent/repeated POS order creation.
// Unknown outcomes stay blocked for reconciliation; a timeout is not proof of failure.
export async function dispatchS3({ orderId, order, env, timeoutMs, send = sendToPos, store }) {
  if (!getS3Config(env).enabled) return { success: false, skipped: true, s3SyncStatus: 'disabled' };
  if (!orderId) throw new Error('Thiếu mã đơn hàng.');
  if (!store) requiredFirebaseEnv(env);
  const path = `integrationOutbox/s3_${orderId}`;
  const db = store || {
    get: () => getDocument(env, path),
    put: (value, version) => commitWrites(env, [{
      update: { name: documentName(env, path), fields: encodeFields(value) },
      currentDocument: version ? { updateTime: version } : { exists: false }
    }]),
    finish: value => commitWrites(env, [{
      update: { name: documentName(env, path), fields: encodeFields(value) }
    }])
  };
  const previous = await db.get();
  if (previous?.state === 'completed') return { success: true, alreadySynced: true, s3SyncStatus: 'synced', s3OrderId: previous.s3OrderId };
  if (['processing', 'needs_review'].includes(previous?.state)) return { success: false, s3SyncStatus: 'needs_review', error: 'Đơn đang gửi hoặc chưa rõ kết quả POS. Cần đối soát trước khi gửi lại.' };
  const record = { orderId, state: 'processing', attempts: Number(previous?.attempts || 0) + 1, updatedAt: new Date() };
  try { await db.put(record, previous?._updateTime); }
  catch { return { success: false, s3SyncStatus: 'pending', error: 'Đơn đã được tiến trình khác tiếp nhận hoặc chưa thể ghi nhật ký đồng bộ.' }; }
  let result;
  try { result = await send({ orderId, order, env, timeoutMs }); }
  catch { result = { success: false, needsReview: true, s3SyncStatus: 'needs_review', error: 'Chưa xác định được kết quả gửi POS.' }; }
  try {
    await db.finish({ ...record, state: result.success ? 'completed' : result.needsReview ? 'needs_review' : 'retryable',
      ...(result.s3OrderId ? { s3OrderId: result.s3OrderId } : {}), updatedAt: new Date() });
  } catch {
    // Keep the processing lock; never risk a second external order.
    return { success: false, s3SyncStatus: 'needs_review', error: 'Cần đối soát POS vì chưa ghi được kết quả đồng bộ.' };
  }
  return result;
}

export const syncOrderToS3 = dispatchS3;

// Issuing the sales invoice is the only call that deducts POS stock, so it needs the
// same durable guard as the preorder. Without it, two admins completing the same order
// at the same time would both invoice it and stock would be deducted twice.
// Unknown outcomes stay blocked until a human reconciles them on S3, because retrying
// an invoice that actually succeeded would deduct stock a second time.
export async function dispatchInvoiceS3({ orderId, order, env, timeoutMs, send = sendInvoiceToPos, store, force = false }) {
  if (!getS3Config(env).enabled) return { success: false, skipped: true, s3InvoiceStatus: 'disabled' };
  if (!orderId) throw new Error('Thiếu mã đơn hàng.');
  if (!store) requiredFirebaseEnv(env);
  const path = `integrationOutbox/s3inv_${orderId}`;
  const db = store || {
    get: () => getDocument(env, path),
    put: (value, version) => commitWrites(env, [{
      update: { name: documentName(env, path), fields: encodeFields(value) },
      currentDocument: version ? { updateTime: version } : { exists: false }
    }]),
    finish: value => commitWrites(env, [{
      update: { name: documentName(env, path), fields: encodeFields(value) }
    }])
  };
  const previous = await db.get();
  if (previous?.state === 'completed') {
    return { success: true, alreadyInvoiced: true, s3InvoiceStatus: 'issued', s3InvoiceRequestId: previous.s3InvoiceRequestId };
  }
  if (!force && ['processing', 'needs_review'].includes(previous?.state)) {
    return { success: false, s3InvoiceStatus: 'needs_review', needsReview: true, error: 'Hoá đơn đang gửi hoặc chưa rõ kết quả POS. Cần đối soát trên S3 trước khi xuất lại.' };
  }
  const record = {
    orderId,
    state: 'processing',
    attempts: Number(previous?.attempts || 0) + 1,
    updatedAt: new Date(),
    ...(force ? { forcedAt: new Date() } : {})
  };
  try { await db.put(record, previous?._updateTime); }
  catch { return { success: false, s3InvoiceStatus: 'needs_review', error: 'Hoá đơn đã được tiến trình khác tiếp nhận hoặc chưa thể ghi nhật ký xuất hoá đơn.' }; }
  let result;
  try { result = await send({ orderId, order, env, timeoutMs }); }
  catch { result = { success: false, s3InvoiceStatus: 'needs_review', needsReview: true, error: 'Chưa xác định được kết quả xuất hoá đơn POS.' }; }
  const state = result.success ? 'completed' : result.s3InvoiceStatus === 'needs_review' ? 'needs_review' : 'retryable';
  try {
    await db.finish({
      ...record,
      state,
      ...(result.s3InvoiceRequestId ? { s3InvoiceRequestId: result.s3InvoiceRequestId } : {}),
      updatedAt: new Date()
    });
  } catch {
    // Keep the processing lock; never risk a second invoice (double stock deduction).
    return { success: false, s3InvoiceStatus: 'needs_review', needsReview: true, error: 'Cần đối soát POS vì chưa ghi được kết quả xuất hoá đơn.' };
  }
  return result;
}
