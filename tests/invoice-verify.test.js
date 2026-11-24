import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVnNumber, parseInvoiceText, reconcileInvoice } from '../scripts/verify-invoice.mjs';

// Bản in thật của ES3 (pdftotext -layout), đơn có voucher 133.000đ nhưng không
// có dòng khuyến mãi nào — đúng tình huống đã gặp trên hd_test.
const REAL_INVOICE_TEXT = `
                                 CÔNG TY TNHH FIELDMAN
                                                  HÓA ĐƠN GIÁ TRỊ GIA TĂNG
Họ tên người mua hàng (Buyer): Bán cho người tiêu dùng
Hình thức thanh toán (Payment method): TM/CK

STT             Tên hàng hóa, dịch vụ               Đơn vị tính    Số lượng             Đơn giá                     Thành tiền
 (No)           (Name of goods and services)            (Unit)      (Quantity)          (Unit price)                  (Amount)

        KEM BODY DƯỠNG TRẮNG HƯƠNG
  1                                                    Tuýp              1,00              276.000,00                        217.918       0                                                  217.918
        NƯỚC HOA 200G - TWON

  2     NƯỚC HOA TANMAYA-D'VAH                          Hộp              1,00              179.000,00                        141.331       0                                                  141.331

  3     SỮA TẮM - TWON                                 Tuýp              1,00              177.000,00                        139.752       0                                                  139.752

Tổng chịu thuế 0% (0% VAT):                                                                     499.001                                                                                       499.001

TỔNG CỘNG (Grand total):                                                                        499.000                                             0                                    499.000
`;

const GIANG_ORDER = {
  id: 'ord_giang_499',
  items: [
    { s3ProductId: 1800406, name: 'Twon Kem Body Dưỡng Trắng Hương Nước Hoa', quantity: 1, price: 276000 },
    { s3ProductId: 1800412, name: "D'VAH Nước Hoa Tanmaya", quantity: 1, price: 179000 },
    { s3ProductId: 1800408, name: 'Twon Sữa tắm Twon', quantity: 1, price: 177000 }
  ],
  subtotal: 632000,
  discountAmount: 133000,
  couponCode: 'GIANG',
  shippingFee: 0,
  total: 499000,
  paymentMethod: 'cod'
};

test('parseVnNumber đọc định dạng tiền Việt (chấm nghìn, phẩy lẻ)', () => {
  assert.equal(parseVnNumber('276.000,00'), 276000);
  assert.equal(parseVnNumber('1,00'), 1);
  assert.equal(parseVnNumber('217.918'), 217918);
  assert.equal(parseVnNumber('499.000'), 499000);
  assert.equal(parseVnNumber('0'), 0);
  assert.equal(parseVnNumber('ABC'), null);
  assert.equal(parseVnNumber('200G'), null);
});

test('parseInvoiceText bóc đúng 3 dòng hàng và tổng của hóa đơn ES3 thật', () => {
  const invoice = parseInvoiceText(REAL_INVOICE_TEXT);
  assert.equal(invoice.items.length, 3);
  assert.deepEqual(
    invoice.items.map(item => [item.quantity, item.unitPrice, item.amount]),
    [[1, 276000, 217918], [1, 179000, 141331], [1, 177000, 139752]]
  );
  // Tên dài bị pdftotext bọc dòng: lấy dòng text phía trên khi dòng số không có tên.
  assert.match(invoice.items[0].name, /KEM BODY DƯỠNG TRẮNG HƯƠNG/);
  assert.equal(invoice.grossFromLines, 632000);
  assert.equal(invoice.netFromLines, 499001);
  assert.equal(invoice.discountFromLines, 132999, 'S3 tự làm tròn phân bổ nên mất 1đ so với 133.000');
  assert.equal(invoice.grandTotal, 499000);
  assert.equal(invoice.promoRows.length, 0, 'hóa đơn thật không có dòng khuyến mãi nào');
});

test('reconcileInvoice chấm đúng: khớp tiền nhưng phạt vì voucher không hiển thị', () => {
  const invoice = parseInvoiceText(REAL_INVOICE_TEXT);
  const { checks, passed } = reconcileInvoice(invoice, GIANG_ORDER);

  // Toàn bộ số tiền khớp trong dung sai 1đ/dòng (S3 tự làm tròn phân bổ).
  for (const check of checks) {
    if (check.name !== 'Dòng khuyến mãi hiển thị') {
      assert.ok(check.pass, `${check.name} phải khớp: ${JSON.stringify(check)}`);
    }
  }
  const display = checks.find(check => check.name === 'Dòng khuyến mãi hiển thị');
  assert.equal(display.pass, false);
  assert.match(display.note, /không có dòng khuyến mãi/);
  assert.equal(passed, false);
});

test('reconcileInvoice bắt lệch đơn giá giữa web và S3', () => {
  const invoice = parseInvoiceText(REAL_INVOICE_TEXT);
  const staleOrder = {
    ...GIANG_ORDER,
    items: GIANG_ORDER.items.map((item, index) => index === 1 ? { ...item, price: 177000 } : item),
    subtotal: 630000,
    total: 497000
  };
  const { checks, passed } = reconcileInvoice(invoice, staleOrder);
  const priceCheck = checks.find(check => /Dòng 2.*đơn giá/.test(check.name));
  assert.equal(priceCheck.pass, false, 'web 177.000 nhưng S3 in 179.000 phải bị phạt');
  assert.equal(passed, false);
});

test('reconcileInvoice đạt hết khi hóa đơn có dòng khuyến mãi', () => {
  const invoice = parseInvoiceText(REAL_INVOICE_TEXT + '\n        Khuyến mãi: Voucher GIANG giảm 133.000đ\n');
  assert.equal(invoice.promoRows.length, 1);
  assert.match(invoice.promoRows[0], /Voucher GIANG/);
  const { passed } = reconcileInvoice(invoice, GIANG_ORDER);
  assert.equal(passed, true);
});

test('reconcileInvoice với đơn không voucher không đòi dòng khuyến mãi', () => {
  const noVoucherText = REAL_INVOICE_TEXT
    .replace('217.918       0', '276.000       0')
    .replace('141.331       0', '179.000       0')
    .replace('139.752       0', '177.000       0')
    .replaceAll('499.001', '632.000')
    .replaceAll('499.000', '632.000');
  const invoice = parseInvoiceText(noVoucherText);
  const order = { ...GIANG_ORDER, discountAmount: 0, couponCode: null, total: 632000 };
  const { passed } = reconcileInvoice(invoice, order);
  assert.equal(passed, true);
});
