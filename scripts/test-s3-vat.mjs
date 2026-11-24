#!/usr/bin/env node
// Kiểm tra luồng VAT khi đồng bộ hóa đơn sang S3POS sandbox.
//
//   node scripts/test-s3-vat.mjs
//   S3_BASE_URL=https://m.present.es3.vn S3_USERNAME=... S3_PASSWORD=... \
//   S3_BRANCH_ID=9147 node scripts/test-s3-vat.mjs
//
// Kịch bản: web SkinID nhập giá ĐÃ gồm VAT, worker gửi InvoicePayload với
// VAT = "0" / VATTaxAmount = 0 (theo tài liệu ES3: S3 lưu số liệu đúng như
// đối tác gửi, chỉ cộng VAT khi giá chưa gồm VAT). Script login sandbox,
// lấy sản phẩm thật trong chi nhánh, tạo 1 hóa đơn test rồi đọc lại chi
// tiết hóa đơn để đối chiếu: nếu S3 tự cộng VAT, tổng lưu sẽ khác số gửi.
//
// Mã thoát: 0 = không bị cộng VAT (khớp), 1 = lệch, 2 = lỗi hạ tầng/API.

import {
  getOrRefreshToken,
  mapOrderToS3InvoicePayload,
  toS3InvoiceDate
} from '../worker/services/s3Service.js';

const baseUrl = (process.env.S3_BASE_URL || 'https://m.present.es3.vn').replace(/\/+$/, '');
const username = process.env.S3_USERNAME || '';
const password = process.env.S3_PASSWORD || '';
const branchId = Number(process.env.S3_BRANCH_ID || 9147);

if (!username || !password) {
  console.error('Thiếu S3_USERNAME / S3_PASSWORD (biến môi trường).');
  process.exit(2);
}

const config = {
  baseUrl,
  username,
  password,
  branchId,
  cashierId: 0,
  paymentOptionCash: 0,
  paymentOptionTransfer: 0,
  enabled: true
};

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML hoặc rỗng */ }
  return { status: response.status, json, text };
};

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

console.log(`== Sandbox: ${baseUrl} | branch ${branchId} ==`);

// 1. Login (lấy token + UserId làm Cashier)
const login = await api('/Vision/Accounts/Login/v3', {
  method: 'POST',
  body: { Username: username, Password: password }
});
if (login.status !== 200 || !login.json?.AuthenticationData?.AccessToken) {
  console.error('Login thất bại:', login.status, (login.text || '').slice(0, 300));
  process.exit(2);
}
const token = login.json.AuthenticationData.AccessToken;
const cashierId = num(login.json.UserId)
  ?? num(login.json.AuthenticationData?.UserId)
  ?? num(Object.values(login.json).find(value => typeof value === 'object' && value && num(value.UserId) !== null)?.UserId)
  ?? 0;
console.log(`Login OK. UserId (Cashier) = ${cashierId}, chi nhánh:`,
  (login.json.AccessibleBranches || []).map(b => `${b.Name}#${b.Id}`).join(', '));

// 2. Phương thức thanh toán (API 5.3)
const payments = await api(`/Vision/GetPaymentTypes/vi/v3`, { token });
const paymentGroups = Array.isArray(payments.json) ? payments.json : (payments.json?.paymentMethods || payments.json?.data || []);
const paymentOptions = paymentGroups.flatMap(group => Array.isArray(group?.paymentOptions) ? group.paymentOptions : []);
if (!paymentOptions.length) {
  console.error('Không đọc được PaymentTypes:', (payments.text || '').slice(0, 200));
  process.exit(2);
}
const paymentOption = num(paymentOptions[0]?.YS_SystemStatusID) ?? num(paymentOptions[0]?.id);
console.log('PaymentOptions:', paymentOptions.map(p => `${p.Name ?? p.StatusDisplayValue}=${p.YS_SystemStatusID}`).join(', '));

// 3. Danh mục sản phẩm chi nhánh (API 5.4) — chọn 2 sản phẩm còn bán, giá > 0
const catalog = await api(`/Vision/Products/AllPageV2/1?branchId=${branchId}&pageSize=50`, { token });
const products = (catalog.json?.products || catalog.json?.Products || catalog.json?.data || catalog.json?.Data || [])
  .map(p => ({
    id: num(p.YS_ProductID ?? p.Id ?? p.productId ?? p.id),
    name: p.Name ?? p.ProductName ?? p.name ?? '?',
    code: p.Code ?? p.ProductCode ?? p.code ?? '',
    price: num(p.SalePrice ?? p.Price ?? p.price)
  }))
  .filter(p => p.id > 0 && p.price > 0);
if (!products.length) {
  console.error('Danh mục rỗng hoặc không đọc được:', (catalog.text || '').slice(0, 300));
  process.exit(2);
}
const picked = products.slice(0, 2);
console.log('Sản phẩm chọn:', picked.map(p => `${p.name} (${p.id}) = ${p.price}đ`).join(' ; '));

// 4. Dựng đơn giả — giá lấy từ danh mục S3 (web SkinID nhập giá đã gồm VAT)
const orderId = `VATTEST-${Date.now()}`;
const order = {
  id: orderId,
  paymentMethod: 'bank_transfer',
  couponCode: '',
  note: 'Hóa đơn kiểm thử luồng VAT (không phải đơn thật).',
  customer: null,
  items: picked.map(p => ({
    productId: p.id,
    s3ProductId: p.id,
    productCode: p.code,
    name: p.name,
    price: p.price,
    quantity: 1
  }))
};
const payload = mapOrderToS3InvoicePayload(order, { ...config, cashierId, paymentOptionTransfer: paymentOption }, 0);
console.log('\n== PAYLOAD GỬI ĐI ==');
console.log(JSON.stringify({
  RequestId: payload.RequestId, BranchId: payload.BranchId, Cashier: payload.Cashier,
  CustomerId: payload.CustomerId, TotalAmount: payload.TotalAmount, InvoiceAmount: payload.InvoiceAmount,
  InvoiceDiscount: payload.InvoiceDiscount, VAT: '(order không có trường VAT; dòng bên dưới)',
  Payments: payload.Payments,
  Items: payload.Items.map(i => ({ ProductName: i.ProductName, PriceSold: i.PriceSold, QuantitySold: i.QuantitySold, Discount: i.Discount, ProductVAT: i.ProductVAT, ProductVATTaxAmount: i.ProductVATTaxAmount }))
}, null, 2));

// 5. Lưu hóa đơn (API 5.9)
const save = await api('/Vision/Invoices/Save/v2', { method: 'POST', body: payload, token });
console.log('\n== SAVE/v2 ==', save.status, JSON.stringify(save.json ?? (save.text || '').slice(0, 200)));
if (save.status !== 200) process.exit(2);

// 6. Trạng thái xử lý (API 5.10) — chờ hàng đợi xử lý xong để lấy InvoiceID
let check = await api(`/Vision/Order/Check/${encodeURIComponent(payload.RequestId)}`, { token });
console.log('\n== ORDER/CHECK (lần đầu) ==', check.status, 'Status:', check.json?.Status);
let invoiceId = num(check.json?.InvoiceId ?? check.json?.InvoiceID ?? check.json?.YS_InvoiceID);
for (let attempt = 0; attempt < 8 && !invoiceId; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  check = await api(`/Vision/Order/Check/${encodeURIComponent(payload.RequestId)}`, { token });
  invoiceId = num(check.json?.InvoiceId ?? check.json?.InvoiceID ?? check.json?.YS_InvoiceID);
  console.log(`Chờ xử lý (lần ${attempt + 1}): Status=${check.json?.Status}, InvoiceId=${invoiceId ?? '(chưa có)'}`);
  if (/fail|error/i.test(String(check.json?.Status || ''))) break;
}
const queuedOrder = (() => { try { return JSON.parse(check.json?.Message || 'null'); } catch { return null; } })();

// 7. Đọc lại chi tiết hóa đơn (API 5.11)
let detail = null;
if (invoiceId) {
  for (const body of [{ InvoiceId: invoiceId }, { InvoiceID: invoiceId }, { YS_InvoiceID: invoiceId }]) {
    const read = await api('/Vision/GetInvoiceDetailByInvoiceID', { method: 'POST', body, token });
    const inner = read.json?.m_Item1;
    if (read.status === 200 && inner && inner.YS_InvoiceID) {
      detail = inner;
      const lines = read.json.m_Item2 || [];
      console.log(`\n== DETAIL (InvoiceId ${invoiceId}) == Số hóa đơn S3: ${inner.InvoiceNumber}`);
      console.log(JSON.stringify({
        TotalAmount: inner.TotalAmount, InvoiceAmount: inner.InvoiceAmount,
        VAT: inner.VAT, VATTaxAmount: inner.VATTaxAmount,
        Lines: lines.length ? lines : '(endpoint không trả kèm dòng hàng — xem bản đơn trong hàng đợi ở trên)'
      }, null, 2));
      break;
    }
    console.log(`Detail thử ${JSON.stringify(body)} -> ${read.status}`, (read.text || '').slice(0, 120));
  }
} else {
  console.log('\nKhông lấy được InvoiceID từ Order/Check — dùng bản đơn S3 lưu trong hàng đợi để đối chiếu.');
}

// 8. Đối chiếu — ưu tiên chi tiết hóa đơn; nếu chưa có thì dùng bản đơn S3 đã lưu trong hàng đợi
console.log('\n== KẾT LUẬN LUỒNG VAT ==');
const sentTotal = num(payload.InvoiceAmount);
const sentLinePrice = num(payload.Items[0]?.PriceSold);
let failures = 0;
let source = 'chi tiết hóa đơn (API 5.11)';

const itemOf = (index) => detail?.items?.[index] ?? detail?.InvoiceItems?.[index] ?? detail?.invoiceItems?.[index] ?? queuedOrder?.Items?.[index] ?? null;
const pickField = (obj, ...keys) => { for (const key of keys) if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key]; return undefined; };

let savedTotal = num(pickField(detail, 'InvoiceAmount', 'invoiceAmount', 'TotalAmount', 'totalAmount'));
if (savedTotal === null && queuedOrder) { savedTotal = num(pickField(queuedOrder, 'InvoiceAmount', 'TotalAmount')); source = 'bản đơn S3 lưu trong hàng đợi (Order/Check)'; }
if (savedTotal === null) {
  console.log('⚠ Không đọc lại được hóa đơn từ S3.');
  console.log('  Kiểm tra thay thế: đối chiếu trên web present.es3.vn — nếu Tổng cộng hóa đơn =', sentTotal, 'đ thì PASS.');
  process.exit(2);
}
if (savedTotal === sentTotal) {
  console.log(`✓ [${source}] Tổng S3 lưu = ${savedTotal}đ = số web gửi. KHÔNG bị cộng thêm VAT.`);
} else {
  failures += 1;
  console.log(`✗ LỆCH: S3 lưu tổng ${savedTotal}đ ≠ web gửi ${sentTotal}đ → nghi bị cộng VAT (x1.1?) hay đơn giá khác catalog.`);
}

const savedLinePrice = num(pickField(itemOf(0), 'PriceSold', 'priceSold', 'UnitPrice'));
if (savedLinePrice !== null) {
  if (savedLinePrice === sentLinePrice) {
    console.log(`✓ Đơn giá dòng = ${savedLinePrice}đ = giá đã gồm VAT trên web (không bị tăng).`);
  } else {
    failures += 1;
    console.log(`✗ Đơn giá dòng S3 = ${savedLinePrice}đ ≠ web gửi ${sentLinePrice}đ.`);
  }
}

const savedLineVat = num(pickField(itemOf(0), 'ProductVATTaxAmount', 'VATTaxAmount', 'vatTaxAmount'));
const savedOrderVat = pickField(detail ?? queuedOrder, 'VAT', 'vat');
const savedOrderVatAmount = num(pickField(detail ?? queuedOrder, 'VATTaxAmount', 'vatTaxAmount'));
console.log(`ℹ VAT S3 lưu: VAT = ${JSON.stringify(savedOrderVat)}, VATTaxAmount = ${JSON.stringify(savedOrderVatAmount)}, dòng đầu = ${JSON.stringify(savedLineVat)}`);
console.log('  (Web gửi VAT = 0/null. S3 giữ nguyên theo tài liệu ES3 §lưu ý: không tự tính lại tiền.)');

process.exit(failures ? 1 : 0);
