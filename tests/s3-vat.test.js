const { test } = require('node:test');
const assert = require('node:assert/strict');

test('S3 invoice VAT - ProductVAT/ProductVATTaxAmount theo bảng thuế suất từ catalog', async () => {
  const { mapOrderToS3InvoicePayload } = await import('../worker/services/s3Service.js');

  const config = { branchId: 9147, cashierId: 16668, paymentOptionTransfer: 49149 };
  const baseOrder = {
    id: 'VAT-test-order',
    paymentMethod: 'bank_transfer',
    couponCode: '',
    items: [
      { productId: 'p1', s3ProductId: 111, productCode: 'SKU1', name: 'Sản phẩm thuế 8%', price: 12000, quantity: 2 },
      { productId: 'p2', s3ProductId: 222, productCode: 'SKU2', name: 'Sản phẩm không thuế', price: 50000, quantity: 1 }
    ]
  };

  // 1. Không có bảng thuế suất → giữ hành vi cũ (0) — không phá luồng hiện có.
  const noRates = mapOrderToS3InvoicePayload(baseOrder, config, 0);
  assert.equal(noRates.Items[0].ProductVAT, '0');
  assert.equal(noRates.Items[0].ProductVATTaxAmount, 0);
  assert.equal(noRates.InvoiceAmount, 74000);

  // 2. Có thuế suất 8% cho dòng 1 → ProductVAT "8", tiền thuế trích từ giá đã gồm VAT:
  //    24000 × 8 / 108 = 1777.78 → làm tròn 1778 (đúng ví dụ của S3: 2 × 12.000 thuế 8% = 1.778).
  const rates8 = new Map([[111, 8]]);
  const withRates = mapOrderToS3InvoicePayload(baseOrder, config, 0, rates8);
  assert.equal(withRates.Items[0].ProductVAT, '8');
  assert.equal(withRates.Items[0].ProductVATTaxAmount, 1778);
  // Dòng không khai thuế suất trong bảng → giữ 0.
  assert.equal(withRates.Items[1].ProductVAT, '0');
  assert.equal(withRates.Items[1].ProductVATTaxAmount, 0);
  // Tổng tiền KHÔNG đổi vì VAT chỉ là trường trích ra từ giá đã gồm VAT.
  assert.equal(withRates.InvoiceAmount, 74000);
  assert.equal(withRates.TotalAmount, 74000);

  // 3. Có voucher: VAT trích trên thành tiền SAU giảm của dòng. Voucher 4.000đ
  //    phân bổ theo tỷ lệ giá: dòng 1 = round(4000×24000/74000) = 1297,
  //    net = 22.703 → thuế = 22703 × 8/108 = 1682. Dòng 2 = 2703.
  const discounted = mapOrderToS3InvoicePayload({ ...baseOrder, discountAmount: 4000, couponCode: 'SKINID10' }, config, 0, rates8);
  assert.equal(discounted.Items[0].Discount, '1297');
  assert.equal(discounted.Items[1].Discount, '2703');
  assert.equal(discounted.Items[0].ProductVATTaxAmount, 1682);
  assert.equal(discounted.InvoiceAmount, 70000);

  // 4. Hàng không chịu thuế → "KCT", tiền thuế 0.
  const kct = mapOrderToS3InvoicePayload(baseOrder, config, 0, new Map([[111, 'KCT']]));
  assert.equal(kct.Items[0].ProductVAT, 'KCT');
  assert.equal(kct.Items[0].ProductVATTaxAmount, 0);

  // 5. Thuế suất 10%: 24.000 × 10/110 = 2181.82 → 2182.
  const rates10 = mapOrderToS3InvoicePayload(baseOrder, config, 0, new Map([[111, 10]]));
  assert.equal(rates10.Items[0].ProductVAT, '10');
  assert.equal(rates10.Items[0].ProductVATTaxAmount, 2182);

  // 6. vatRates dạng object thuần (không Map) cũng nhận.
  const objRates = mapOrderToS3InvoicePayload(baseOrder, config, 0, { 111: 8 });
  assert.equal(objRates.Items[0].ProductVAT, '8');
  assert.equal(objRates.Items[0].ProductVATTaxAmount, 1778);
});

test('S3 preorder VAT - PreOrderItems dùng trường VAT/VATTaxAmount (không dùng ProductVAT)', async () => {
  const { mapOrderToS3Payload } = await import('../worker/services/s3Service.js');

  const config = { branchId: 9147, cashierId: 16668 };
  const order = {
    id: 'pre-vat-test',
    paymentMethod: 'bank_transfer',
    discountAmount: 0,
    couponCode: '',
    customer: { name: 'Test', phone: '0909123456' },
    items: [
      { productId: 'p1', s3ProductId: 111, productCode: 'SKU1', name: 'Sản phẩm thuế 8%', price: 12000, quantity: 2 },
      { productId: 'p2', s3ProductId: 222, productCode: 'SKU2', name: 'KCT', price: 50000, quantity: 1 }
    ]
  };

  // Không có bảng thuế → hành vi cũ (0), không phát sinh trường ProductVAT/ProductVATTaxAmount.
  const plain = mapOrderToS3Payload(order, config, 922848);
  assert.equal(plain.PreOrderItems[0].VAT, '0');
  assert.equal(plain.PreOrderItems[0].VATTaxAmount, 0);
  assert.equal(plain.PreOrderItems[0].ProductVAT, undefined);
  assert.equal(plain.PreOrderItems[0].ProductVATTaxAmount, undefined);
  assert.equal(plain.PreOrder.VAT, 0);
  assert.equal(plain.PreOrder.VATTaxAmount, 0);
  assert.equal(plain.PreOrder.InvoiceAmount, 74000);

  // Có thuế suất: dòng 1 = 8% → 1778; dòng 2 = KCT → 0. Cấp đơn vẫn VAT = 0, tổng không đổi.
  const rates = new Map([[111, 8], [222, 'KCT']]);
  const withRates = mapOrderToS3Payload(order, config, 922848, rates);
  assert.equal(withRates.PreOrderItems[0].VAT, '8');
  assert.equal(withRates.PreOrderItems[0].VATTaxAmount, 1778);
  assert.equal(withRates.PreOrderItems[0].ProductVAT, undefined);
  assert.equal(withRates.PreOrderItems[0].ProductVATTaxAmount, undefined);
  assert.equal(withRates.PreOrderItems[1].VAT, 'KCT');
  assert.equal(withRates.PreOrderItems[1].VATTaxAmount, 0);
  assert.equal(withRates.PreOrder.VAT, 0);
  assert.equal(withRates.PreOrder.VATTaxAmount, 0);
  assert.equal(withRates.PreOrder.InvoiceAmount, 74000);
  assert.equal(withRates.PreOrder.TotalAmount, 74000);
});
