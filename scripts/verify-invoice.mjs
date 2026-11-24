#!/usr/bin/env node
// Đối chiếu hóa đơn S3 (PDF) với đơn hàng trên web.
//
//   node scripts/verify-invoice.mjs <hoa-don.pdf> [--order don-hang.json] [--json] [--text]
//
// - PDF được bóc văn bản bằng `pdftotext -layout` (poppler-utils).
// - Không có --order: chỉ báo cáo số liệu trên hóa đơn (tổng dòng, tiền giảm,
//   có dòng "Khuyến mãi/Giảm giá" hay không).
// - Có --order (JSON dạng document Firestore: items/subtotal/discountAmount/
//   couponCode/total): đối chiếu từng dòng + tổng + kiểm tra voucher có hiển thị.
//   Phép phân bổ kỳ vọng lấy từ allocateVoucherLines của worker nên cùng một
//   nguồn sự thật với payload gửi S3.
//
// Mã thoát: 0 = mọi kiểm tra đạt, 1 = lệch hoặc thiếu dòng khuyến mãi, 2 = lỗi dùng.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { allocateVoucherLines } from '../worker/services/s3Service.js';

const VN_NUMBER = /\d[\d.,]*/;
const MONEY_SHAPE = /(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d{2})/;
// Dòng "khuyến mãi" thật phải mang tên giảm giá và không phải các nhãn cố định
// của mẫu hóa đơn (cột thuế, tổng hợp, tiêu đề...).
const PROMO_LABEL = /khuyến\s*mãi|giảm\s*giá|chiết\s*khấu|voucher/i;
const STRUCTURAL_LABEL = /thu[êe]|vat|tổng hợp|in summary|grand total|amount|currency|mẫu số|số tra cứu|đơn vị tiền/i;

export function parseVnNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d[\d.,]*$/.test(text)) return null;
  const normalized = /,\d{1,2}$/.test(text)
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(/\./g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function isTextOnlyLine(line) {
  if (!line.trim()) return false;
  if (MONEY_SHAPE.test(line)) return false;
  if (/^\s*\d{1,3}\s+\S/.test(line)) return false;
  if (STRUCTURAL_LABEL.test(line)) return false;
  return true;
}

/**
 * Bóc dòng hàng + tổng + dòng khuyến mãi từ văn bản hóa đơn (định dạng
 * `pdftotext -layout` của mẫu hóa đơn GTGT ES3).
 */
export function parseInvoiceText(text) {
  const lines = String(text ?? '').split('\n');
  const items = [];
  const usedNameLines = new Set();

  const dataRow = /^\s*(\d{1,3})\s+(.*?)\s{2,}(\S+)\s+(VN)\s+(VN)\s+(VN)\s+(\d+)\s+(VN)\s*$/
    .source.replaceAll('VN', VN_NUMBER.source);
  const dataRowRe = new RegExp(dataRow);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(dataRowRe);
    if (!match) continue;

    let name = match[2].trim();
    if (!name) {
      // Tên nằm trên dòng riêng phía trên (pdftotext bọc dòng dài). Chỉ lấy
      // dòng text thuần chưa dùng; có thể thiếu đoạn xuống dòng phía dưới —
      // tên chỉ để đọc báo cáo, đối chiếu dựa trên đơn giá và số lượng.
      for (let up = index - 1; up >= 0 && !name; up -= 1) {
        if (!isTextOnlyLine(lines[up]) || usedNameLines.has(up)) continue;
        if (up < index - 3) break;
        name = lines[up].trim();
        usedNameLines.add(up);
      }
    }

    items.push({
      stt: Number(match[1]),
      name,
      unit: match[3],
      quantity: parseVnNumber(match[4]),
      unitPrice: parseVnNumber(match[5]),
      amount: parseVnNumber(match[6]),
      vatPercent: Number(match[7]),
      totalWithVat: parseVnNumber(match[8])
    });
  }

  let grandTotal = null;
  let vatBandTotals = [];
  const promoRows = [];
  for (const line of lines) {
    if (/tổng cộng|grand total/i.test(line)) {
      const numbers = line.match(/\d[\d.,]*/g) || [];
      const parsed = numbers.map(parseVnNumber).filter(value => Number.isFinite(value));
      if (parsed.length) grandTotal = parsed[parsed.length - 1];
    }
    const band = line.match(/tổng chịu thu[êe]\s*(\d+)%/i);
    if (band) {
      const numbers = (line.match(/\d[\d.,]*/g) || []).map(parseVnNumber).filter(Number.isFinite);
      vatBandTotals.push({ percent: Number(band[1]), net: numbers[numbers.length - 1] ?? null });
    }
    if (PROMO_LABEL.test(line) && !STRUCTURAL_LABEL.test(line)) {
      promoRows.push(line.trim().replace(/\s{2,}/g, ' '));
    }
  }
  vatBandTotals = vatBandTotals.filter(band => band.net !== null && band.net > 0);

  const grossFromLines = items.reduce((sum, item) => sum + (item.unitPrice || 0) * (item.quantity || 0), 0);
  const netFromLines = items.reduce((sum, item) => sum + (item.amount || 0), 0);

  return {
    items,
    grossFromLines,
    netFromLines,
    grandTotal,
    vatBandTotals,
    promoRows,
    discountFromLines: grossFromLines - netFromLines
  };
}

/**
 * So sánh hóa đồng với đơn web. Trả về { checks, passed } — mỗi check là
 * { name, expected, actual, pass, note }.
 */
export function reconcileInvoice(invoice, order, { tolerancePerLine = 1 } = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const subtotal = Number(order?.subtotal ?? items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0));
  const discountAmount = Math.max(0, Number(order?.discountAmount) || 0);
  const total = Number(order?.total ?? subtotal - discountAmount);
  const tolerance = tolerancePerLine * Math.max(1, invoice.items.length);

  const checks = [];
  const add = (name, expected, actual, pass, note = '') => checks.push({ name, expected, actual, pass, note });

  add('Số dòng hàng', items.length, invoice.items.length, items.length === invoice.items.length);

  const expectedDiscounts = allocateVoucherLines(items, discountAmount);
  const lineCount = Math.min(items.length, invoice.items.length);
  for (let index = 0; index < lineCount; index += 1) {
    const orderItem = items[index];
    const invoiceItem = invoice.items[index];
    const label = `Dòng ${index + 1} (${(orderItem.name || invoiceItem.name || '?').slice(0, 40)})`;
    const orderPrice = Number(orderItem.price || 0);
    add(`${label} đơn giá`, orderPrice, invoiceItem.unitPrice, orderPrice === invoiceItem.unitPrice,
      orderPrice !== invoiceItem.unitPrice ? 'S3 ghi đơn giá khác giá web — kiểm tra đồng bộ giá' : '');
    const orderQuantity = Number(orderItem.quantity || 1);
    add(`${label} số lượng`, orderQuantity, invoiceItem.quantity, orderQuantity === invoiceItem.quantity);
    const expectedAmount = orderPrice * orderQuantity - expectedDiscounts[index];
    const delta = Math.abs(expectedAmount - (invoiceItem.amount || 0));
    add(`${label} thành tiền`, expectedAmount, invoiceItem.amount, delta <= tolerancePerLine,
      delta > tolerancePerLine ? 'khớp cả giảm giá phân bổ lẻ đồng' : '');
  }

  add('Tổng chưa giảm (giá×SL)', subtotal, invoice.grossFromLines, Math.abs(subtotal - invoice.grossFromLines) <= tolerancePerLine);
  add('Tổng giảm giá', discountAmount, invoice.discountFromLines, Math.abs(discountAmount - invoice.discountFromLines) <= tolerance);
  const invoiceNet = invoice.grandTotal ?? invoice.netFromLines;
  add('Tổng thanh toán', total, invoiceNet, Math.abs(total - invoiceNet) <= tolerance);

  const shouldShowPromo = discountAmount > 0;
  add('Dòng khuyến mãi hiển thị', shouldShowPromo ? 'có' : 'không', invoice.promoRows.length ? 'có' : 'không',
    shouldShowPromo === (invoice.promoRows.length > 0),
    shouldShowPromo && !invoice.promoRows.length ? 'đơn có voucher nhưng bản in không có dòng khuyến mãi/giảm giá nào' : '');

  return { checks, passed: checks.every(check => check.pass) };
}

function extractPdfText(pdfPath) {
  const result = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    console.error('Không tìm thấy lệnh pdftotext. Cài đặt: sudo apt-get install poppler-utils');
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`pdftotext thất bại (mã ${result.status}): ${result.stderr}`);
    process.exit(2);
  }
  return result.stdout;
}

function formatValue(value) {
  return typeof value === 'number' ? value.toLocaleString('vi-VN') : String(value);
}

function printReport(invoice, reconciliation) {
  console.log('\n=== DÒNG HÀNG TRÊN HÓA ĐƠN ===');
  for (const item of invoice.items) {
    console.log(`${String(item.stt).padStart(2)}. ${(item.name || '(không rõ tên)').slice(0, 45).padEnd(45)} SL ${item.quantity} × ${formatValue(item.unitPrice)}đ → ${formatValue(item.amount)}đ`);
  }
  console.log(`Tổng giá×SL      : ${formatValue(invoice.grossFromLines)}đ`);
  console.log(`Tổng sau giảm    : ${formatValue(invoice.netFromLines)}đ`);
  console.log(`Tiền giảm (suy ra): ${formatValue(invoice.discountFromLines)}đ`);
  if (invoice.grandTotal !== null) console.log(`TỔNG CỘNG in trên hóa đơn: ${formatValue(invoice.grandTotal)}đ`);
  console.log(`Dòng khuyến mãi  : ${invoice.promoRows.length ? invoice.promoRows.join(' | ') : '(không có)'}`);

  if (reconciliation) {
    console.log('\n=== ĐỐI CHIẾU VỚI ĐƠN WEB ===');
    for (const check of reconciliation.checks) {
      const mark = check.pass ? '✓' : '✗';
      console.log(`${mark} ${check.name}: hóa đơn ${formatValue(check.actual)} / kỳ vọng ${formatValue(check.expected)}${check.note ? ` — ${check.note}` : ''}`);
    }
    console.log(reconciliation.passed ? '\nKẾT QUẢ: KHỚP.' : '\nKẾT QUẢ: LỆCH — xem các dòng ✗ phía trên.');
  }
}

async function main(argv) {
  const pdfPath = argv[0];
  const flags = new Set(argv.slice(1).filter(arg => arg.startsWith('--')));
  const orderFlag = argv.find(arg => arg.startsWith('--order='));
  const orderIndex = argv.indexOf('--order');
  const orderPath = orderFlag
    ? orderFlag.slice('--order='.length)
    : (orderIndex >= 0 ? (argv[orderIndex + 1] || null) : null);

  if (!pdfPath || flags.has('--help') || flags.has('-h')) {
    console.log('Cách dùng: node scripts/verify-invoice.mjs <hoa-don.pdf> [--order don-hang.json] [--json] [--text]');
    process.exit(2);
  }
  if (!existsSync(pdfPath)) {
    console.error(`Không tìm thấy file hóa đơn: ${pdfPath}`);
    process.exit(2);
  }

  const text = extractPdfText(pdfPath);
  if (flags.has('--text')) console.log(text);

  const invoice = parseInvoiceText(text);
  if (!invoice.items.length) {
    console.error('Không bóc được dòng hàng nào từ PDF — kiểm tra --text để xem văn bản trích xuất.');
    process.exit(1);
  }

  let order = null;
  if (orderPath) {
    if (!existsSync(orderPath)) {
      console.error(`Không tìm thấy file đơn hàng: ${orderPath}`);
      process.exit(2);
    }
    order = JSON.parse(readFileSync(orderPath, 'utf8'));
  }

  const reconciliation = order ? reconcileInvoice(invoice, order) : null;

  if (flags.has('--json')) {
    console.log(JSON.stringify({ invoice, reconciliation }, null, 2));
  } else {
    printReport(invoice, reconciliation);
  }

  if (!invoice.items.length || (reconciliation && !reconciliation.passed)) process.exit(1);
  process.exit(0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main(process.argv.slice(2));
}
