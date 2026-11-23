# Chính sách SkinID V2.0

Nguồn: PDF `SkinID Policy V2.0.pdf` do người dùng cung cấp, 16 trang, SHA-256 `87717c9f01582e092a5a361442949d04d9d7b00235447ee26e46034095e1dff5`. Website lấy thông tin đơn vị vận hành và 10 chương, gồm 54 điều khoản con, 9 bảng. Không đưa ghi chú/phụ lục kiểm tra nội bộ lên web.

- Nội dung: `src/data/legalPolicies.js`.
- Thông tin công ty: `src/data/companyInfo.js`.
- Trang và renderer: `src/pages/PolicyPage.jsx`, `src/components/policies/`.
- Route: [routes.json](../reference/routes.json); đường dẫn khiếu nại cũ tiếp tục tương thích.

## Thông tin kế thừa

Theo yêu cầu dùng thông tin đã có: Fieldman, MST 0319200638, đại diện Trần Long, hotline 0924.093.461, email operation@fieldman.vn, đầu mối dữ liệu Ông Trần Trung Nghĩa. Ngày hiệu lực 14/10/2026 kế thừa chính sách cũ, chưa xác nhận là ngày ban hành mới.

Giữ mốc đổi ý 7 ngày và các thời hạn hỗ trợ từ chính sách cũ. Phí giao tiêu chuẩn khớp checkout hiện tại: 30.000đ, miễn từ 500.000đ; không dùng ví dụ 25.000đ/499.000đ trong PDF để âm thầm đổi checkout.

## Nội dung cần xác nhận

Các ô trong dấu `[ ]` chưa có nguồn tin cậy vẫn để rõ trong nội dung. Đã điền: đối tác công nghệ AI là WEIRD&WOW INC (thương hiệu Acie, Hoa Kỳ), địa chỉ 200 Great Road, Bedford, MA 01730, USA, quốc gia đặt máy chủ Hoa Kỳ (nguồn footer acie.skin); tên thiết bị Acie® cùng các chỉ số cảm biến (hydration, oiliness, elasticity) và chỉ số suy luận AI (mụn, lỗ chân lông, sắc tố/nám, nếp nhăn, độ đàn hồi) theo thông số công bố của Acie và hệ thống phân tích hiện có; bảo hành thiết bị 12 tháng (nguồn trang Warranty của Acie); thời gian giữ dữ liệu tại đối tác tối đa 30 ngày. Các mốc kinh doanh đã được chủ quản xác nhận trực tiếp: COD giới hạn 5.000.000đ, hoàn tiền 2 ngày làm việc sau phê duyệt, hạn sử dụng tối thiểu 6 tháng khi giao, nhật ký kỹ thuật lưu 12 tháng, hotline bảo hành 0704 136 862 tại 35 đường số 3 Phường Tân Mỹ TP.HCM, phụ kiện tiêu hao capsule/đầu đo + pin, mục 5.3 sửa theo thực tế (chỉ VietQR + COD, chưa có cổng thẻ/ví), bỏ câu độ chính xác vì Acie không công bố số liệu. Còn chờ duy nhất: `[SỐ / LINK XÁC NHẬN]` — số đăng ký website thương mại điện tử với Bộ Công Thương của skinid.vn chưa có, giữ placeholder + cảnh báo.

Các mốc lưu/xóa ảnh kế thừa (30 ngày, ảnh lưu chủ động hoặc sau 24 tháng không hoạt động) là nội dung chính sách, chưa chứng minh backend có job thực thi. Consent, xóa ảnh/dữ liệu, xử lý yêu cầu dữ liệu, bảo hành thiết bị/ACIE và các cam kết vận hành phải được xác nhận với backend và chủ quản trước công bố chính thức.

Không đưa PDF gốc chứa ghi chú nội bộ vào tài nguyên public. Bản gốc và báo cáo chuyển đổi lịch sử lưu ngoài repo.
