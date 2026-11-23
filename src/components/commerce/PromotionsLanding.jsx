import { useCallback, useEffect, useRef, useState } from 'react';
import { formatPrice } from '../../features/catalog/index.js';
import { fetchAdminPromotions } from '../../features/admin/index.js';
import { useCampaign } from '../../features/content/index.js';
import { CURATED_COMBOS, RETAIL_50_DEALS } from '../../data/promotions.js';
import { COMPANY_INFO } from '../../data/companyInfo.js';
import { assetUrl } from '../../assets/index.js';
import StorePromotionNotice from './StorePromotionNotice.jsx';
import ComboName from './ComboName.jsx';

/* Contact channels used to confirm the 50% programme. The website cannot verify the 3 social steps,
   so retail 50% items never go to the cart: customers are sent to an advisor instead. Add a Messenger link here when available. */
const CONTACT = {
  zalo: COMPANY_INFO.zaloUrl,
  messenger: '',
  tel: `tel:${COMPANY_INFO.hotline.replace(/\./g, '')}`,
  hotline: COMPANY_INFO.hotlineDisplay,
  hours: COMPANY_INFO.workingHours
};

const DEFAULT_VOUCHERS = [
  { code: 'FREESHIP', label: 'Miễn phí vận chuyển', sub: 'Hỗ trợ tối đa 30.000đ phí vận chuyển.' },
  { code: 'SKINID10', label: 'Giảm 10% đơn hàng', sub: 'Đơn từ 200.000đ, giảm tối đa 150.000đ.' },
  { code: 'WELCOME50', label: 'Ưu đãi 50.000đ', sub: 'Dành cho đơn hàng từ 300.000đ.' }
];

function normalizeVouchers(list) {
  return list.filter((v) => v && v.active !== false && v.code).map((v) => {
    const value = Number(v.discountValue || v.value) || 0;
    return {
      code: String(v.code).trim().toUpperCase(),
      label: v.type === 'shipping' ? 'Miễn phí vận chuyển' : ['percent', 'percentage'].includes(v.type) ? `Giảm ${value}% đơn hàng` : `Ưu đãi ${formatPrice(value)}`,
      sub: v.description || (v.minOrderValue ? `Đơn từ ${formatPrice(Number(v.minOrderValue))}.` : 'Áp dụng theo điều kiện chương trình.')
    };
  });
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const openProduct = (productId) => document.dispatchEvent(new CustomEvent('skinid:open-product-detail', { detail: { productId } }));

/** Scroll progress (0..1) of a tall section whose child sticks; reports the active stage and writes --p on the node. */
function useStickyStages(count) {
  const ref = useRef(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const total = Math.max(1, rect.height - window.innerHeight);
      const p = Math.min(1, Math.max(0, -rect.top / total));
      node.style.setProperty('--p', p.toFixed(4));
      setActive(Math.min(count - 1, Math.floor(p * count)));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(frame); };
  }, [count]);
  const goTo = useCallback((index) => {
    const node = ref.current;
    if (!node) return;
    const total = node.offsetHeight - window.innerHeight;
    const top = node.getBoundingClientRect().top + window.scrollY + total * ((index + 0.5) / count);
    window.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [count]);
  return { ref, active, goTo };
}

/** Writes --hp (0..1) while the hero scrolls away, for parallax. */
function useHeroParallax() {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion()) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      node.style.setProperty('--hp', Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height))).toFixed(4));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, []);
  return ref;
}

function AdvisorButtons({ className = '', light = false }) {
  return (
    <div className={`pl-advisor ${light ? 'pl-advisor--light' : ''} ${className}`}>
      <a className={`btn pl-btn pl-btn--consult ${light ? 'pl-btn--white' : 'btn--primary'}`} href={CONTACT.zalo} target="_blank" rel="noopener noreferrer" aria-label="Tư vấn ưu đãi tại cửa hàng qua Zalo"><span>Tư vấn ưu đãi</span><i aria-hidden="true">↗</i></a>
      {CONTACT.messenger && <a className="btn btn--secondary pl-btn" href={CONTACT.messenger} target="_blank" rel="noopener noreferrer">Inbox Messenger</a>}
      <a className="pl-advisor__tel" href={CONTACT.tel}>Hotline {CONTACT.hotline}</a>
    </div>
  );
}

function Hero({ campaign, retailDeals = RETAIL_50_DEALS }) {
  const ref = useHeroParallax();
  const endDate = campaign?.endsAt || campaign?.endAt ? new Date(campaign.endsAt || campaign.endAt) : null;
  const deals = retailDeals?.length ? retailDeals : RETAIL_50_DEALS;
  const floaters = [deals[0], deals[1], deals[2], deals[3], deals[6] || deals[0], deals[5] || deals[1]].filter(Boolean);
  return (
    <header className="pl-hero" ref={ref}>
      <div className="pl-hero__copy">
        <span className="skinid-editorial-kicker">ƯU ĐÃI TẠI CỬA HÀNG · TWON &amp; D'VAH</span>
        <h1 className="skinid-editorial-title">Like &amp; share, <em>ưu đãi 50% tại cửa hàng.</em></h1>
        <p>Chọn sản phẩm TWON, D'VAH và bộ quà tặng yêu thích. Nhắn SkinID để xác nhận điều kiện ưu đãi tại cửa hàng; giá chương trình không áp dụng cho đơn online.</p>
        <div className="pl-hero__cta">
          <a className="btn btn--primary pl-btn" href="#san-pham-giam-50"><span>Xem sản phẩm giảm 50%</span><i aria-hidden="true">↓</i></a>
          <a className="collection-text-link" href="#bo-qua-tang">Xem bộ quà tặng <span aria-hidden="true">→</span></a>
        </div>
        {endDate && Number.isFinite(endDate.getTime()) && <small className="pl-hero__deadline">Chương trình đến {endDate.toLocaleDateString('vi-VN')}</small>}
      </div>
      <div className="pl-hero__art" aria-hidden="true">
        <span className="pl-ring pl-ring--a" /><span className="pl-ring pl-ring--b" />
        <div className="pl-medal"><small>GIẢM ĐẾN</small><b>50<sup>%</sup></b><small>TẠI CỬA HÀNG</small></div>
        {floaters.map((product, i) => (
          <span key={product.id || i} className={`pl-float pl-float--${i + 1}`} style={{ '--depth': [60, -40, 90, -70, 50, -30][i] }}>
            <img src={assetUrl(product.image, product.brandSlug)} alt="" loading="lazy" />
          </span>
        ))}
      </div>
    </header>
  );
}

/* ---------- Retail 50% (advisor CTA instead of cart) ---------- */
function RetailDeals({ retailDeals = RETAIL_50_DEALS }) {
  const deals = retailDeals?.length ? retailDeals : RETAIL_50_DEALS;
  return (
    <section className="pl-retail" id="san-pham-giam-50" aria-label="Sản phẩm bán lẻ giảm 50%">
      <div className="pl-head">
        <div>
          <span className="skinid-editorial-kicker">DAILY LITTLE JOYS</span>
          <h2>Giảm 50% tại cửa hàng, <em>cho điều bạn yêu thích.</em></h2>
        </div>
        <p>Mức giá dưới đây dành cho chương trình tại cửa hàng. Hoàn thành các bước và nhắn SkinID để xác nhận điều kiện trước khi đến; không áp dụng cho đơn online. Giá đã gồm VAT.</p>
      </div>
      <ul className="pl-retail__grid">
        {deals.map((product) => (
          <li key={product.id} className="pl-card">
            <button type="button" className="pl-card__visual" onClick={() => openProduct(product.id)} aria-label={`Xem thông tin và giá online của ${product.name}`}>
              <img src={assetUrl(product.image, product.brandSlug)} alt="" loading="lazy" />
              <em>−{product.discountPercent}%</em>
              <span className="pl-card__hint">Thông tin & giá online</span>
            </button>
            <span className="pl-eyebrow">{product.brand}</span>
            <h3>{product.name}</h3>
            <ul className="pl-card__tags">{(product.features || []).slice(0, 2).map((f) => <li key={f}>{f}</li>)}</ul>
            <div className="pl-price"><span className="promotion-price-channel">Giá ưu đãi tại cửa hàng</span><b>{formatPrice(product.price)}</b><del title="Giá trước ưu đãi tại cửa hàng">{formatPrice(product.originalPrice)}</del></div>
            <a className="btn btn--primary pl-btn pl-btn--consult pl-card__cta" href={CONTACT.zalo} target="_blank" rel="noopener noreferrer" aria-label={`Tư vấn ưu đãi tại cửa hàng cho ${product.name}`}><span>Tư vấn ưu đãi</span><i aria-hidden="true">↗</i></a>
            <small className="pl-card__note">Áp dụng tại cửa hàng · Nhân viên xác nhận điều kiện</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- Scrollytelling: gift sets ---------- */
function GiftStory({ combos = CURATED_COMBOS }) {
  const list = combos?.length ? combos : CURATED_COMBOS;
  const { ref, active, goTo } = useStickyStages(list.length);
  const current = list[active] || list[0] || {};
  return (
    <section className="pl-gifts" id="bo-qua-tang" aria-label="Bộ quà tặng SkinID">
      <div className="pl-head">
        <div><span className="skinid-editorial-kicker">THE GIFT EDIT</span><h2>Ba cách gửi trao <em>yêu thương.</em></h2></div>
        <p>Giá combo áp dụng tại cửa hàng. Nhắn SkinID để xác nhận bộ quà, giá và tình trạng hàng trước khi đến.</p>
      </div>
      <div className="pl-story" ref={ref}>
        <div className="pl-story__sticky">
          <div className="pl-story__media" aria-hidden="true">
            {list.map((combo, i) => <img key={combo.id} className={`pl-story__img${i === active ? ' is-active' : i < active ? ' is-past' : ''}`} src={assetUrl(combo.image)} alt="" loading="lazy" />)}
            <span className="pl-story__saving"><small>TIẾT KIỆM</small><b>{current.discountPercent}%</b></span>
          </div>
          <div className="pl-story__panel">
            <span className="skinid-editorial-kicker">{current.code}</span>
            <div className="pl-story__slides">
              {list.map((combo, i) => (
                <div key={combo.id} className={`pl-story__slide${i === active ? ' is-active' : ''}`} aria-hidden={i !== active}>
                  <span className="pl-eyebrow">{combo.subtitle}</span>
                  <h3><ComboName combo={combo} /></h3>
                  <p>{combo.slogan}</p>
                  <div className="pl-story__items">
                    {(combo.products || []).map((product) => (
                      <button type="button" key={product.id} onClick={() => openProduct(product.id)} tabIndex={i === active ? 0 : -1} title={`Xem ${product.name}`}>
                        <img src={assetUrl(product.image, product.brandSlug)} alt={product.name} /><span>{product.capacity}</span>
                      </button>
                    ))}
                  </div>
                  <ul>{(combo.items || []).map((item) => <li key={item}>{item}</li>)}</ul>
                  <div className="pl-price"><span className="promotion-price-channel">Giá combo tại cửa hàng</span><b>{formatPrice(combo.price)}</b><del title="Tổng giá mua lẻ tại cửa hàng">{formatPrice(combo.originalPrice)}</del></div>
                  <a className="btn btn--primary pl-btn pl-btn--consult" tabIndex={i === active ? 0 : -1} href={CONTACT.zalo} target="_blank" rel="noopener noreferrer" aria-label={`Tư vấn ${combo.title} tại cửa hàng`}>
                    <span>Tư vấn bộ quà</span><i aria-hidden="true">↗</i>
                  </a>
                </div>
              ))}
            </div>
            <div className="pl-story__nav">
              {list.map((combo, i) => <button type="button" key={combo.id} className={i === active ? 'is-active' : ''} onClick={() => goTo(i)} aria-label={`Xem ${combo.title}`}>0{i + 1}</button>)}
              <span className="pl-story__bar"><i /></span>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile / reduced motion: plain cards */}
      <div className="pl-gift-cards">
        {list.map((combo, index) => (
          <article key={combo.id} className="pl-gift-card">
            <div className="pl-gift-card__img"><img src={assetUrl(combo.image)} alt={`Bộ quà ${combo.title}`} loading="lazy" /><span>0{index + 1}</span><em>Tiết kiệm {combo.discountPercent}%</em></div>
            <div className="pl-gift-card__body">
              <span className="pl-eyebrow">{combo.subtitle}</span>
              <h3><ComboName combo={combo} /></h3>
              <p>{combo.slogan}</p>
              <ul>{(combo.items || []).map((item) => <li key={item}>{item}</li>)}</ul>
              <div className="pl-price"><span className="promotion-price-channel">Giá combo tại cửa hàng</span><b>{formatPrice(combo.price)}</b><del title="Tổng giá mua lẻ tại cửa hàng">{formatPrice(combo.originalPrice)}</del></div>
              <a className="btn btn--primary pl-btn pl-btn--consult" href={CONTACT.zalo} target="_blank" rel="noopener noreferrer" aria-label={`Tư vấn ${combo.title} tại cửa hàng`}>
                <span>Tư vấn bộ quà</span><i aria-hidden="true">↗</i>
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Vouchers({ vouchers }) {
  const [copied, setCopied] = useState('');
  const [message, setMessage] = useState('');
  const copy = async (code) => {
    try { await navigator.clipboard.writeText(code); setCopied(code); setMessage(`Đã sao chép mã ${code}.`); }
    catch { setMessage(`Bạn có thể nhập mã ${code} tại bước thanh toán.`); }
  };
  if (!vouchers.length) return null;
  return (
    <section className="pl-vouchers" id="vouchers" aria-label="Mã ưu đãi">
      <div className="pl-head"><div><span className="skinid-editorial-kicker">MÃ ƯU ĐÃI</span><h2>Thêm một chút <em>quà nhỏ.</em></h2></div></div>
      <p className="online-voucher-note">Mã ưu đãi dành cho đơn online, áp dụng theo điều kiện của từng mã.</p>
      <div className="pl-vouchers__grid">
        {vouchers.map((voucher) => (
          <div className="pl-voucher" key={voucher.code}>
            <div><span className="pl-voucher__code">{voucher.code}</span><h3>{voucher.label}</h3><p>{voucher.sub}</p></div>
            <button type="button" className="btn btn--secondary" onClick={() => copy(voucher.code)} aria-label={`Sao chép mã ${voucher.code}`}>{copied === voucher.code ? 'Đã chép ✓' : 'Sao chép'}</button>
          </div>
        ))}
      </div>
      <p className="pl-feedback" role="status" aria-live="polite">{message}</p>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="pl-final" aria-label="Liên hệ nhận ưu đãi">
      <span className="pl-final__orb" aria-hidden="true" />
      <div className="pl-final__copy">
        <span className="skinid-editorial-kicker">INBOX NGAY</span>
        <h2>Ưu đãi tại cửa hàng. <em>SkinID luôn sẵn sàng tư vấn.</em></h2>
        <p>Đội ngũ tư vấn sẽ xác nhận điều kiện, địa điểm và giá ưu đãi tại cửa hàng. Giá chương trình không áp dụng cho checkout online. Hỗ trợ {CONTACT.hours}.</p>
      </div>
      <AdvisorButtons light />
    </section>
  );
}

export default function PromotionsLanding() {
  const [vouchers, setVouchers] = useState(DEFAULT_VOUCHERS);
  const { campaign: firestoreCampaign, combos, flashSale } = useCampaign();
  const [campaign, setCampaign] = useState(firestoreCampaign);

  useEffect(() => {
    if (firestoreCampaign) setCampaign(firestoreCampaign);
  }, [firestoreCampaign]);

  useEffect(() => {
    let mounted = true;
    const load = () => fetchAdminPromotions().then((data) => {
      if (!mounted) return;
      if (Array.isArray(data?.vouchers)) setVouchers(normalizeVouchers(data.vouchers));
      if (data?.campaign) setCampaign(data.campaign);
    }).catch(() => {});
    const sync = (event) => {
      if (Array.isArray(event.detail?.vouchers)) setVouchers(normalizeVouchers(event.detail.vouchers));
      else if (event.detail?.campaign) setCampaign(event.detail.campaign);
      else load();
    };
    load();
    const events = ['storage', 'skinid:vouchers-updated', 'skinid:campaign-updated'];
    events.forEach((name) => window.addEventListener(name, sync));
    return () => { mounted = false; events.forEach((name) => window.removeEventListener(name, sync)); };
  }, []);

  const activeCombos = combos?.length ? combos : CURATED_COMBOS;
  const activeDeals = flashSale?.length ? flashSale : RETAIL_50_DEALS;

  return (
    <div className="pl-page">
      <Hero campaign={campaign} retailDeals={activeDeals} />
      <StorePromotionNotice campaign={campaign} />
      <RetailDeals retailDeals={activeDeals} />
      <GiftStory combos={activeCombos} />
      <Vouchers vouchers={vouchers} />
      <FinalCta />
    </div>
  );
}
