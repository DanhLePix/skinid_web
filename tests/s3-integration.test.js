const { test } = require('node:test');
const assert = require('node:assert/strict');

test('S3 Retail Software Integration - Config, Mapping, Token & Fail-Safe', async () => {
  const { getS3Config } = await import('../worker/app/env.js');
  const {
    getOrRefreshToken,
    mapOrderToS3Payload,
    syncOrderToS3,
    resetS3TokenCache
  } = await import('../worker/services/s3Service.js');

  // 1. Config Defaults and Overrides
  const defaultConfig = getS3Config({});
  assert.equal(defaultConfig.baseUrl, 'https://m.es3.vn');
  assert.equal(defaultConfig.username, '');
  assert.equal(defaultConfig.branchId, 9099);
  assert.equal(defaultConfig.cashierId, 16614);
  assert.equal(defaultConfig.enabled, false);

  const customConfig = getS3Config({
    S3_BASE_URL: 'https://m.fm.es3.vn',
    S3_USERNAME: 'prod_fieldman',
    S3_BRANCH_ID: '9999',
    S3_SYNC_ENABLED: 'false'
  });
  assert.equal(customConfig.baseUrl, 'https://m.fm.es3.vn');
  assert.equal(customConfig.username, 'prod_fieldman');
  assert.equal(customConfig.branchId, 9999);
  assert.equal(customConfig.enabled, false);

  // 2. Order Mapping - Vietcombank Transfer
  const mockBankOrder = {
    id: 'ord_vcb_123456789',
    customer: {
      name: 'Nguyễn Văn Test',
      phone: '0909123456',
      address: '72 Lê Thánh Tôn, Bến Nghé, Quận 1, TP.HCM'
    },
    items: [
      {
        sku: 'RILASTIL-D-CLAR',
        s3ProductId: 101,
        name: 'Serum Mờ Nám Rilastil D-Clar 30ml',
        quantity: 2,
        price: 1150000
      }
    ],
    subtotal: 2300000,
    discountAmount: 150000,
    couponCode: 'SKINID10',
    shippingFee: 0,
    total: 2150000,
    paymentMethod: 'bank_transfer',
    note: 'Giao giờ hành chính'
  };

  const bankPayload = mapOrderToS3Payload(mockBankOrder, defaultConfig, 841894);
  assert.equal(bankPayload.PreOrder.CustomerID, 841894);
  assert.equal(bankPayload.PreOrder.TotalAmount, 2300000);
  assert.equal(bankPayload.PreOrder.InvoiceAmount, 2150000);
  assert.equal(bankPayload.PreOrder.CustomerReceived, 0);
  // S3 sums InvoiceDiscount and PromotionDiscountAmount, so the voucher must ride in
  // exactly one of them or the customer is charged the discount twice.
  assert.equal(bankPayload.PreOrder.InvoiceDiscount, 150000);
  assert.equal(bankPayload.PreOrder.PromotionDiscountAmount, 0);
  assert.equal(bankPayload.PreOrder.PromotionAmount, 0);
  assert.equal(bankPayload.PreOrder.PromotionDiscount, "0");
  assert.equal(bankPayload.PreOrder.PromotionName, "");
  assert.match(bankPayload.PreOrder.Notes, /Vietcombank 1063583549/);
  assert.equal(bankPayload.PreOrderPayments.length, 0);
  assert.equal(bankPayload.PreOrderItems.length, 1);
  assert.equal(bankPayload.PreOrderItems[0].QuantitySold, 2);
  assert.equal(bankPayload.PreOrderItems[0].PriceSold, 1150000);
  assert.equal(bankPayload.SelectedBranch, 9099);

  // 3. Order Mapping - COD
  const mockCodOrder = {
    id: 'ord_cod_987654321',
    customer: { name: 'Trần Thị COD', phone: '0988776655', address: 'Đà Nẵng' },
    items: [{ s3ProductId: 102, name: 'Sữa Rửa Mặt Rilastil', quantity: 1, price: 450000 }],
    subtotal: 450000,
    discountAmount: 0,
    total: 450000,
    paymentMethod: 'cod'
  };
  const codPayload = mapOrderToS3Payload(mockCodOrder, defaultConfig, 922848);
  assert.equal(codPayload.PreOrderPayments.length, 0); // COD has no upfront payment in PreOrder
  assert.equal(codPayload.PreOrder.CustomerReceived, 0);
  assert.match(codPayload.PreOrder.Notes, /COD/);

  // 4. Token Retrieval and Caching
  resetS3TokenCache();
  let loginFetchCalls = 0;
  const mockFetch = async (url, options) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      loginFetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          AuthenticationData: { AccessToken: 'mock_jwt_token_s3_pos' }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const token1 = await getOrRefreshToken(defaultConfig, mockFetch);
  assert.equal(token1, 'mock_jwt_token_s3_pos');
  assert.equal(loginFetchCalls, 1);

  // Second call should return cached token without fetching
  const token2 = await getOrRefreshToken(defaultConfig, mockFetch);
  assert.equal(token2, 'mock_jwt_token_s3_pos');
  assert.equal(loginFetchCalls, 1);

  // 5. Fail-Safe Resilience: Network failure must NEVER throw
  const testEnv = {
    S3_USERNAME: 'test_cashier',
    S3_PASSWORD: 'test_password_123',
    S3_SYNC_ENABLED: 'true'
  };

  resetS3TokenCache();
  const failingFetch = async () => {
    throw new Error('ETIMEDOUT: Connection to S3 POS timed out');
  };

  const failResult = await syncOrderToS3({
    orderId: 'ord_fail_test',
    order: mockBankOrder,
    env: testEnv,
    fetchFn: failingFetch
  });

  assert.equal(failResult.success, false);
  assert.equal(failResult.s3SyncStatus, 'pending');
  assert.match(failResult.error, /ETIMEDOUT/);

  // 6. Successful Sync Flow
  resetS3TokenCache();
  const successfulFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } })
      };
    }
    if (url.includes('/Vision/Customers')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ Success: true, SingleData: 919519 })
      };
    }
    if (url.includes('/Vision/AddNewPreOrder/v2')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, message: 'success', code: '00' })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const successResult = await syncOrderToS3({
    orderId: 'ord_success_test_123',
    order: mockBankOrder,
    env: testEnv,
    fetchFn: successfulFetch
  });

  assert.equal(successResult.success, true);
  assert.equal(successResult.s3SyncStatus, 'synced');
  assert.equal(successResult.s3CustomerId, 919519);
  // AddNewPreOrder/v2 documents only message + code, so there is no S3 id to store. The
  // old code stored our own RequestId as s3OrderId and the admin UI rendered it as an S3
  // reference ("Đã đồng bộ (#SKINID-...)"), which is a number that exists nowhere in S3.
  assert.equal(successResult.s3OrderId, undefined);
  assert.equal(successResult.s3OrderIdUnknown, true);
  assert.match(successResult.s3RequestId, /^SKINID-/);

  // 7. Invoice Mapping - deducted stock stops at the sales invoice, not the preorder
  const { mapOrderToS3InvoicePayload, issueInvoiceToS3 } = await import('../worker/services/s3Service.js');

  const invoicePayload = mapOrderToS3InvoicePayload(mockBankOrder, defaultConfig, 841894);
  assert.equal(invoicePayload.BranchId, 9099);
  assert.equal(invoicePayload.Cashier, 16614);
  assert.equal(invoicePayload.CustomerId, 841894);
  assert.equal(invoicePayload.InvoiceAmount, 2150000);
  assert.equal(invoicePayload.TotalAmount, 2300000);
  assert.equal(invoicePayload.InvoiceDiscount, '150000');
  assert.equal(invoicePayload.CompleteWithCOD, false);
  assert.equal(invoicePayload.Articles, undefined);
  assert.equal(invoicePayload.Items.length, 1);
  assert.equal(invoicePayload.Items[0].YS_ProductID, 101);
  assert.equal(invoicePayload.Items[0].QuantitySold, 2);
  assert.equal(invoicePayload.Payments.length, 1);
  assert.equal(invoicePayload.Payments[0].PaymentOption, 48797);
  assert.match(invoicePayload.RequestId, /^SKINID-INV-/);

  // S3 stores InvoiceDate with a +07:00 offset. Sending UTC "Z" would file invoices
  // created before 07:00 Vietnam time under the previous day on the sales report.
  const { toS3InvoiceDate } = await import('../worker/services/s3Service.js');
  assert.equal(toS3InvoiceDate(new Date('2026-11-16T20:30:00Z')), '2026-11-17T03:30:00+07:00');
  assert.match(invoicePayload.InvoiceDate, /\+07:00$/);

  // COD invoices carry no upfront payment record.
  const codInvoice = mapOrderToS3InvoicePayload(mockCodOrder, defaultConfig, 922848);
  assert.equal(codInvoice.CompleteWithCOD, true);
  assert.equal(codInvoice.Payments, null);
  assert.equal(codInvoice.InvoiceAmount, 450000);

  // The S3 docs allow CustomerId = 0 for a walk-in customer, so a missing customer
  // must not throw. It must also not be sent as CompleteWithCOD: that flag only
  // applies to orders carrying a customer with a phone and address, and a live
  // Save/v2 call with CompleteWithCOD true + CustomerId 0 answered code "00" while
  // creating nothing (stock unchanged, no invoice in S3's dashboard). Sending
  // CompleteWithCOD false plus the real cash PaymentOption created the invoice.
  const walkInInvoice = mapOrderToS3InvoicePayload(mockCodOrder, defaultConfig, 0);
  assert.equal(walkInInvoice.CustomerId, 0);
  assert.equal(walkInInvoice.CompleteWithCOD, false);
  assert.equal(walkInInvoice.Payments.length, 1);
  assert.equal(walkInInvoice.Payments[0].PaymentOption, 48796); // "Tiền mặt" on account 8234
  assert.equal(walkInInvoice.Payments[0].PaymentAmount, 450000);

  // A bank transfer always records how the money arrived, customer or not.
  const walkInTransfer = mapOrderToS3InvoicePayload(mockBankOrder, defaultConfig, 0);
  assert.equal(walkInTransfer.CompleteWithCOD, false);
  assert.equal(walkInTransfer.Payments[0].PaymentOption, 48797);
  assert.throws(
    () => mapOrderToS3InvoicePayload(mockCodOrder, defaultConfig, -1),
    /mã khách hàng S3/i
  );
  assert.throws(
    () => mapOrderToS3InvoicePayload({ ...mockCodOrder, items: [] }, defaultConfig, 922848),
    /không có sản phẩm/
  );

  // Unmapped products must fail loudly instead of invoicing the wrong item.
  assert.throws(
    () => mapOrderToS3InvoicePayload({ ...mockCodOrder, items: [{ name: 'X', quantity: 1, price: 1 }] }, defaultConfig, 922848),
    /Chưa ánh xạ mã S3/
  );

  // 8. Invoice Issuance
  resetS3TokenCache();
  // On-hand stock before and after the call. A successful Save/v2 deducts stock, which
  // is the only independent proof that the invoice exists.
  let invoiceCatalogReads = 0;
  const invoiceFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      invoiceCatalogReads += 1;
      const qty = invoiceCatalogReads === 1 ? 20 : 18; // the 2 units this order sells
      return { ok: true, status: 200, json: async () => ({
        Data: [{ id: 101, name: 'Serum Rilastil', price: 1150000, quantity_on_hand: qty, inventory: true, status: 'active' }],
        Total: 1
      }) };
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const issued = await issueInvoiceToS3({ orderId: 'ord_invoice_ok', order: mockBankOrder, env: testEnv, fetchFn: invoiceFetch });
  assert.equal(issued.success, true);
  assert.equal(issued.s3InvoiceStatus, 'issued');
  assert.equal(issued.verified, true);
  assert.match(issued.s3InvoiceRequestId, /^SKINID-INV-/);

  // S3 answers a retried RequestId with code "01" + "Lỗi trùng requestId". RequestId is
  // derived from the order id, so this proves the invoice exists: it must be recorded as
  // issued instead of blocking the order for a manual reconciliation that cannot help.
  resetS3TokenCache();
  const duplicateFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '01', message: 'Lỗi trùng requestId' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const duplicate = await issueInvoiceToS3({ orderId: 'ord_invoice_dup', order: mockBankOrder, env: testEnv, fetchFn: duplicateFetch });
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.alreadyInvoiced, true);
  assert.equal(duplicate.s3InvoiceStatus, 'issued');
  assert.equal(duplicate.needsReview, undefined);

  // Other code "01" errors are real rejections, not duplicates: they must still be reviewed.
  resetS3TokenCache();
  const otherCodeFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '01', message: 'Chi nhánh không hợp lệ' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const otherCode = await issueInvoiceToS3({ orderId: 'ord_invoice_code01', order: mockBankOrder, env: testEnv, fetchFn: otherCodeFetch });
  assert.equal(otherCode.success, false);
  assert.equal(otherCode.s3InvoiceStatus, 'needs_review');

  // A rejected invoice must surface for reconciliation rather than silently succeeding.
  resetS3TokenCache();
  const rejectedFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '99', message: 'Sai ma hang' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const rejected = await issueInvoiceToS3({ orderId: 'ord_invoice_bad', order: mockBankOrder, env: testEnv, fetchFn: rejectedFetch });
  assert.equal(rejected.success, false);
  assert.equal(rejected.s3InvoiceStatus, 'needs_review');
  assert.match(rejected.error, /Sai ma hang/);

  // 9. Code "00" is not proof: verify the invoice against the branch catalog.
  // A live Save/v2 call with YS_ProductID 999999999 (no such product) answered
  // {"code":"00","message":"success"} and created nothing, so "00" alone must never be
  // reported as issued.
  const catalogResponse = (rows, total = rows.length) => ({ ok: true, status: 200, json: async () => ({ Data: rows, Total: total }) });
  const productRow = (id, qty) => ({ id, name: `SP ${id}`, price: 1150000, quantity_on_hand: qty, inventory: true, status: 'active' });

  // 9a. Unknown product: refused before Save/v2 is even called.
  resetS3TokenCache();
  let saveCalled = false;
  const unknownProductFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      return catalogResponse([productRow(999, 10)]); // order needs product 101
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      saveCalled = true;
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const unknownProduct = await issueInvoiceToS3({ orderId: 'ord_invoice_unknown', order: mockBankOrder, env: testEnv, fetchFn: unknownProductFetch });
  assert.equal(unknownProduct.success, false);
  assert.equal(unknownProduct.s3InvoiceStatus, 'needs_review');
  assert.match(unknownProduct.error, /không tồn tại trên S3/);
  assert.equal(saveCalled, false, 'sản phẩm không tồn tại phải bị chặn trước khi gọi Save/v2');

  // 9b. Inactive product: also refused, because S3 drops such invoices silently.
  resetS3TokenCache();
  const inactiveFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      return catalogResponse([{ ...productRow(101, 10), status: 'un_active' }]);
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const inactive = await issueInvoiceToS3({ orderId: 'ord_invoice_inactive', order: mockBankOrder, env: testEnv, fetchFn: inactiveFetch });
  assert.equal(inactive.success, false);
  assert.equal(inactive.s3InvoiceStatus, 'needs_review');
  assert.match(inactive.error, /un_active/);

  // 9c. Stock drops after the call: that is real proof the invoice was saved.
  resetS3TokenCache();
  let catalogReads = 0;
  const stockDropsFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      catalogReads += 1;
      return catalogResponse([productRow(101, catalogReads === 1 ? 10 : 8)]); // 2 sold
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const verified = await issueInvoiceToS3({ orderId: 'ord_invoice_verified', order: mockBankOrder, env: testEnv, fetchFn: stockDropsFetch });
  assert.equal(verified.success, true);
  assert.equal(verified.s3InvoiceStatus, 'issued');
  assert.equal(verified.verified, true);
  assert.equal(catalogReads, 2, 'phải đọc tồn kho trước và sau khi gửi');

  // 9d. Code "00" with unchanged stock: this is exactly the silent-drop case that made
  // walk-in invoices disappear. It must be parked for review, never reported as issued.
  resetS3TokenCache();
  const silentDropFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      return catalogResponse([productRow(101, 10)]);
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const silentDrop = await issueInvoiceToS3({ orderId: 'ord_invoice_silent', order: mockBankOrder, env: testEnv, fetchFn: silentDropFetch });
  assert.equal(silentDrop.success, false);
  assert.equal(silentDrop.s3InvoiceStatus, 'needs_review');
  assert.equal(silentDrop.needsReview, true);
  assert.match(silentDrop.error, /tồn kho không thay đổi/);
  // The RequestId is kept so an operator can find the request on S3 during reconciliation.
  assert.match(silentDrop.s3InvoiceRequestId, /^SKINID-INV-/);

  // 9e. Catalog unreadable: unknown is not proof. The order must be reviewed, because a
  // dropped invoice and an unreadable catalog look identical from here.
  resetS3TokenCache();
  const catalogDownFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const catalogDown = await issueInvoiceToS3({ orderId: 'ord_invoice_catalog_down', order: mockBankOrder, env: testEnv, fetchFn: catalogDownFetch });
  assert.equal(catalogDown.success, false);
  assert.equal(catalogDown.s3InvoiceStatus, 'needs_review');
  assert.match(catalogDown.error, /không đọc lại được tồn kho/);

  // 9f. verify: false keeps the old behaviour for callers that cannot afford the extra
  // catalogue reads; it trusts code "00" and makes no claim about verification.
  resetS3TokenCache();
  const trustOnly = await issueInvoiceToS3({ orderId: 'ord_invoice_trust', order: mockBankOrder, env: testEnv, fetchFn: silentDropFetch, verify: false });
  assert.equal(trustOnly.success, true);
  assert.equal(trustOnly.s3InvoiceStatus, 'issued');
  assert.equal(trustOnly.verified, undefined);

  // A retried preorder RequestId is also a known outcome, not an ambiguous one: without
  // this the order would sit in needs_review forever even though S3 already has it.
  resetS3TokenCache();
  const duplicatePreOrderFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 'valid_token' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/AddNewPreOrder/v2')) {
      return { ok: true, status: 200, json: async () => ({ code: '01', message: 'Lỗi trùng requestId' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const duplicatePreOrder = await syncOrderToS3({ orderId: 'ord_sync_dup', order: mockBankOrder, env: testEnv, fetchFn: duplicatePreOrderFetch });
  assert.equal(duplicatePreOrder.success, true);
  assert.equal(duplicatePreOrder.alreadySynced, true);
  assert.equal(duplicatePreOrder.s3SyncStatus, 'synced');

  // 10. TotalAmount is gross merchandise, InvoiceAmount is what the customer pays.
  // The docs name TotalAmount "Tổng số tiền sản phẩm chưa áp dụng khuyến mãi, giảm giá",
  // so a missing subtotal must never fall back to the discounted total.
  const { invoiceTotals, fetchS3Inventory, findStockShortages, buildRestockLines } = await import('../worker/services/s3Service.js');

  const noSubtotal = invoiceTotals({ items: [{ price: 500000, quantity: 2 }], discountAmount: 100000, total: 900000 });
  assert.equal(noSubtotal.gross, 1000000, 'gross phải cộng lại từ dòng hàng, không lấy total đã giảm giá');
  assert.equal(noSubtotal.net, 900000);
  assert.equal(noSubtotal.discount, 100000);

  const noLinesNoSubtotal = invoiceTotals({ discountAmount: 100000, total: 900000 });
  assert.equal(noLinesNoSubtotal.gross, 1000000, 'thiếu cả subtotal và dòng hàng thì phải cộng lại giảm giá');

  const fullTotals = invoiceTotals(mockBankOrder);
  assert.equal(fullTotals.gross, 2300000);
  assert.equal(fullTotals.net, 2150000);

  // A payload without subtotal must still report the gross, not the net.
  const grossFromLines = mapOrderToS3InvoicePayload({ ...mockBankOrder, subtotal: undefined }, defaultConfig, 841894);
  assert.equal(grossFromLines.TotalAmount, 2300000);
  assert.equal(grossFromLines.InvoiceAmount, 2150000);

  // The voucher must reach S3 once. S3 subtracts InvoiceDiscount and
  // PromotionDiscountAmount separately, so the real GIANG order (632.000 gross,
  // 133.000 voucher, 499.000 charged) used to land at 366.000 on the POS.
  const voucherOrder = {
    id: 'ord_giang_499',
    items: [
      { s3ProductId: 1808964, name: 'Kem body Lotion 200', quantity: 1, price: 276000 },
      { s3ProductId: 1808965, name: 'Sữa tắm TWON 450', quantity: 1, price: 177000 },
      { s3ProductId: 1808966, name: 'Nước hoa Tamaya 10', quantity: 1, price: 179000 }
    ],
    subtotal: 632000,
    discountAmount: 133000,
    couponCode: 'GIANG',
    shippingFee: 0,
    total: 499000,
    paymentMethod: 'cod'
  };
  const voucherInvoice = mapOrderToS3InvoicePayload(voucherOrder, defaultConfig, 841894);
  assert.equal(voucherInvoice.TotalAmount, 632000);
  assert.equal(voucherInvoice.InvoiceAmount, 499000);
  assert.equal(voucherInvoice.InvoiceDiscount, '133000');

  const voucherPreOrder = mapOrderToS3Payload(voucherOrder, defaultConfig, 841894);
  const chargedTwice = voucherPreOrder.PreOrder.TotalAmount
    - Number(voucherPreOrder.PreOrder.InvoiceDiscount)
    - voucherPreOrder.PreOrder.PromotionDiscountAmount;
  assert.equal(chargedTwice, 499000, 'S3 trừ InvoiceDiscount và PromotionDiscountAmount riêng, nên voucher không được nằm ở cả hai');

  // 11. Branch inventory: POST /Vision/Products/Inventories, and stock shortages block.
  resetS3TokenCache();
  const inventoryCalls = [];
  const inventoryFetch = async (url, options = {}) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 't' } }) };
    }
    if (url.includes('/Vision/Products/Inventories')) {
      inventoryCalls.push({ method: options.method, body: JSON.parse(options.body || '{}') });
      return { ok: true, status: 200, json: async () => ({
        PageData: [
          { YS_ProductID: 101, ProductName: 'Serum', QuantityOnHand: 3, NoStockQuantity: false, Active: true },
          { YS_ProductID: 202, ProductName: 'Voucher', QuantityOnHand: 0, NoStockQuantity: true, Active: true }
        ],
        TotalCount: 2
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const inventory = await fetchS3Inventory({ token: 'tok', config: defaultConfig, fetchFn: inventoryFetch });
  assert.equal(inventory.get(101).quantityOnHand, 3);
  assert.equal(inventory.get(101).tracked, true);
  assert.equal(inventory.get(202).tracked, false, 'NoStockQuantity phải bị loại khỏi kiểm tồn');
  assert.equal(inventoryCalls[0].method, 'POST', 'Inventories chỉ nhận POST; GET trả 405');
  assert.equal(inventoryCalls[0].body.BranchId, 9099, 'tồn kho phải đọc theo chi nhánh');
  // IncludeInactive must default to false: the live API inverts the flag, so true answers
  // with one inactive row instead of the 56 active products.
  assert.equal(inventoryCalls[0].body.IncludeInactive, false);

  assert.deepEqual(findStockShortages([{ YS_ProductID: 101, QuantitySold: 3 }], inventory), []);
  const shortage = findStockShortages([{ YS_ProductID: 101, QuantitySold: 4 }], inventory);
  assert.equal(shortage.length, 1);
  assert.equal(shortage[0].available, 3);
  assert.equal(shortage[0].requested, 4);
  // Untracked products can be sold beyond any "stock" and must never be reported short.
  assert.deepEqual(findStockShortages([{ YS_ProductID: 202, QuantitySold: 50 }], inventory), []);
  // An unreadable inventory is unknown, not empty: it must not invent shortages.
  assert.deepEqual(findStockShortages([{ YS_ProductID: 101, QuantitySold: 99 }], null), []);

  // The same shortage has to stop the invoice before Save/v2 deducts anything.
  resetS3TokenCache();
  let saveCalls = 0;
  const oversoldFetch = async (url) => {
    if (url.includes('/Vision/Accounts/Login/v3')) {
      return { ok: true, status: 200, json: async () => ({ AuthenticationData: { AccessToken: 't' } }) };
    }
    if (url.includes('/Vision/Customers')) {
      return { ok: true, status: 200, json: async () => ({ Success: true, SingleData: 919519 }) };
    }
    if (url.includes('/Vision/Products/AllPageV2')) {
      return catalogResponse([productRow(101, 50)]);
    }
    if (url.includes('/Vision/Products/Inventories')) {
      return { ok: true, status: 200, json: async () => ({
        PageData: [{ YS_ProductID: 101, ProductName: 'Serum', QuantityOnHand: 1, NoStockQuantity: false, Active: true }],
        TotalCount: 1
      }) };
    }
    if (url.includes('/Vision/Invoices/Save/v2')) {
      saveCalls += 1;
      return { ok: true, status: 200, json: async () => ({ code: '00', message: 'success' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const oversold = await issueInvoiceToS3({ orderId: 'ord_invoice_oversold', order: mockBankOrder, env: testEnv, fetchFn: oversoldFetch });
  assert.equal(oversold.success, false);
  assert.equal(oversold.s3InvoiceStatus, 'needs_review');
  assert.match(oversold.error, /Không đủ tồn kho/);
  assert.equal(saveCalls, 0, 'phải chặn trước khi gọi Save\/v2');

  // 12. Restock bookkeeping: the documented API cannot adjust stock, so a cancelled or
  // returned invoiced order records what a human must put back into S3 by hand.
  assert.deepEqual(
    buildRestockLines({ items: [
      { s3ProductId: 1800406, name: 'Kem body Lotion 200', quantity: 2 },
      { s3ProductId: 0, name: 'Chưa map', quantity: 1 },
      { s3ProductId: 1800407, name: 'Kem ủ trắng 250', quantity: 0 }
    ] }),
    [{ s3ProductId: 1800406, name: 'Kem body Lotion 200', quantity: 2 }]
  );
  assert.deepEqual(buildRestockLines({}), []);

  // Disabled POS must skip cleanly, never claim an invoice was issued.
  const skipped = await issueInvoiceToS3({ orderId: 'ord_invoice_off', order: mockBankOrder, env: {}, fetchFn: invoiceFetch });
  assert.equal(skipped.success, false);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.s3InvoiceStatus, 'disabled');

  console.log('PASS: S3 Integration (Config, Token, Mapping, Fail-Safe, mocked API flows) passed.');
});
