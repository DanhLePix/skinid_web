#!/usr/bin/env node
// Xuất hóa đơn điện tử BẢN NHÁP (API 5.17 IssueEInvoice, ConfirmIssueInvoice=false)
// trên một hóa đơn đã có trong S3POS, rồi đọc lại trạng thái EInvoice.
//
//   S3_INVOICE_ID=45511 node scripts/test-s3-einvoice.mjs
//   (mặc định sandbox: S3_BASE_URL=https://m.present.es3.vn)
//
// ConfirmIssueInvoice=false → bản nháp, không phát hành chính thức; true → chính thức.
//
// Mã thoát: 0 = xuất nháp thành công hoặc đã có hóa đơn điện tử, 1 = lỗi.

import {
  getOrRefreshToken
} from '../worker/services/s3Service.js';

const baseUrl = (process.env.S3_BASE_URL || 'https://m.present.es3.vn').replace(/\/+$/, '');
const username = process.env.S3_USERNAME || '';
const password = process.env.S3_PASSWORD || '';
const invoiceId = Number(process.env.S3_INVOICE_ID || 0);
const confirm = (process.env.S3_CONFIRM_ISSUE || '').toLowerCase() === 'true';

if (!username || !password || !invoiceId) {
  console.error('Thiếu S3_USERNAME / S3_PASSWORD / S3_INVOICE_ID (biến môi trường).');
  process.exit(2);
}

const config = { baseUrl, username, password };
const api = async (path, { method = 'POST', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* không phải JSON */ }
  return { status: response.status, json, text };
};

const token = await getOrRefreshToken(config);

// Trước khi xuất: trạng thái EInvoice hiện tại của hóa đơn
const before = await api('/Vision/GetInvoiceDetailByInvoiceID', { body: { InvoiceId: invoiceId }, token });
const invBefore = before.json?.m_Item1;
console.log('== Trước khi xuất ==');
console.log(`Hóa đơn ${invoiceId} — Số S3: ${invBefore?.InvoiceNumber ?? '?'}, Tổng: ${invBefore?.InvoiceAmount ?? '?'}, VAT: ${JSON.stringify(invBefore?.VAT)}, VATTaxAmount: ${JSON.stringify(invBefore?.VATTaxAmount)}`);
console.log(`EInvoice hiện tại: ${JSON.stringify(invBefore?.EInvoice ?? null)}`);

// Xuất bản nháp
console.log(`\n== IssueEInvoice (ConfirmIssueInvoice: ${confirm} — ${confirm ? 'PHÁT HÀNH CHÍNH THỨC' : 'bản nháp'}) ==`);
const issue = await api('/Vision/EInvoice/IssueEInvoice', {
  body: {
    InvoiceID: invoiceId,
    ConfirmIssueInvoice: confirm,
    EInvoice: {
      NguoiMuaTen: 'Khach hang kiem thu VAT (draft)',
      NguoiMuaEmail: 'test@example.com',
      // Mẫu số + ký hiệu phải khớp "Hóa đơn đăng ký phát hành" đã cấu hình
      // trong S3 web (Cài đặt → Hóa đơn điện tử → nhà cung cấp).
      ...(process.env.S3_KHMSHDon ? { KHMSHDon: process.env.S3_KHMSHDon } : {}),
      ...(process.env.S3_KHHDon ? { KHHDon: process.env.S3_KHHDon } : {})
    }
  },
  token
});
console.log('HTTP', issue.status, JSON.stringify(issue.json ?? (issue.text || '').slice(0, 300)));

if (issue.json && (issue.json.IsSuccess || issue.json.code === '00')) {
  const note = /đã xuất hóa đơn|đã có/i.test(String(issue.json.Message || '')) ? '(hóa đơn này đã có hóa đơn điện tử từ trước)' : '';
  console.log(`Kết quả: YS_ID=${issue.json.YS_ID}, Số hóa đơn điện tử=${issue.json.SoHoaDon}, Mã tra cứu=${issue.json.MaTraCuu}, TrangThai=${issue.json.TrangThai} ${note}`);
}

// Đọc lại: EInvoice gắn trên hóa đơn sau khi xuất nháp
const after = await api('/Vision/GetInvoiceDetailByInvoiceID', { body: { InvoiceId: invoiceId }, token });
const inv = after.json?.m_Item1;
console.log('\n== Sau khi xuất ==');
console.log(`Tổng: ${inv?.InvoiceAmount} | VAT: ${JSON.stringify(inv?.VAT)} | VATTaxAmount: ${JSON.stringify(inv?.VATTaxAmount)}`);
console.log(`EInvoice: ${JSON.stringify(inv?.EInvoice ?? null)}`);
console.log('\nXem bản nháp trên web: present.es3.vn → Hóa đơn điện tử / Xem hóa đơn → tìm số hóa đơn trên.');

process.exit(issue.json && (issue.json.IsSuccess || issue.json.code === '00') ? 0 : 1);
