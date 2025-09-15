/*
|----------------------------------------------------------------------------
| usePrinting.ts 
|----------------------------------------------------------------------------
*/

export type PrintProfile =
    | 'thermal-57'
    | 'thermal-58'
    | 'thermal-80'
    | 'thermal-110'
    | 'regular-A3'
    | 'regular-A4'
    | 'regular-A5'
    | 'regular-Letter'
    | 'regular-Legal'
    | 'regular-F4'
    | 'custom';

export type Orientation = 'portrait' | 'landscape';
export type CurrencyFormat = (n: number) => string;
export interface StyledTextSegment {
    text: string;
    className?: string;
    style?: string;
}
export type MetaValue = string | StyledTextSegment | StyledTextSegment[];

export type PrintBlock =
    | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; small?: boolean }
    | { kind: 'hr'; style?: 'dashed' | 'solid' | 'double' }
    | { kind: 'spacer'; size?: number }
    | { kind: 'kv'; rows: Array<{ label: string; value: string }>; labelWidthMm?: number }
    | { kind: 'box'; lines: string[]; align?: 'left' | 'center' | 'right' }
    | { kind: 'line'; char?: '_' | '-'; repeat?: number; align?: 'left' | 'center' | 'right' };

export type QtyFormat = 'xN' | 'Nx' | '(xN)' | '(Nx)';

export interface PrintOptions {
    profile?: PrintProfile;
    orientation?: Orientation; // regular only, default 'portrait'
    marginMm?: number; // default: thermal 2.5mm, regular 12mm
    paperWidthMm?: number; // thermal/custom override
    paperHeightMm?: number; // custom override (regular)
    preview?: boolean; // true: overlay only, no auto print
    autoClose?: boolean; // default true — remove overlay after afterprint
    charCols?: number; // kolom karakter utk blok 'line' (default by width)
    currencyFormatter?: CurrencyFormat;
    thermalColumns?: ('qty' | 'price' | 'total')[];
    mountTarget?: string | Element; // default document.body
    overlay?: boolean; // default true (dim background)
    showControls?: boolean; // default true (print/close bar)
    density?: 'compact' | 'regular'; // default compact (thermal)
    accentColor?: string; // regular invoice accent (default #111827)
    qtyFormat?: QtyFormat;
    regularShowInlineQty?: boolean;
    cssOverrides?: string | string[];
}

export interface ReceiptDataItem {
    name: string;
    qty?: number;
    price?: number;
    total?: number;
    note?: string;
}

export interface ReceiptData {
    rawHtml?: string;
    header?: {
        logoUrl?: string;
        companyName?: string;
        address?: string;
        title?: string | StyledTextSegment | StyledTextSegment[];
        meta?: Record<string, MetaValue>;
    };
    items?: ReceiptDataItem[];
    totals?: Array<{
        label: string | StyledTextSegment | StyledTextSegment[];
        value: string | StyledTextSegment | StyledTextSegment[];
        isBold?: boolean;
        className?: string;
    }>;
    customBlocks?: PrintBlock[];
    qrcode?: { data: string; caption?: string };
    barcode?: { data: string; caption?: string };
    footer?: { lines?: string[] };
}

/* ============================== Main =================================== */

export function usePrinting() {
    let defaultProfile: PrintProfile | undefined;
    let defaultFormatter: CurrencyFormat = (n) =>
        new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n);

    function setDefaultProfile(p: PrintProfile) {
        defaultProfile = p;
    }
    function setDefaultCurrencyFormatter(fn: CurrencyFormat) {
        defaultFormatter = fn;
    }

    async function printReceipt(data?: ReceiptData, options?: PrintOptions) {
        const profile = options?.profile || defaultProfile || 'thermal-58';
        const currency = options?.currencyFormatter || defaultFormatter;
        const bodyHtml = data?.rawHtml ? data.rawHtml : renderAutoLayout({ data: data || {}, profile, currency, options });

        const teardown = await mountInPlace(bodyHtml, profile, options);
        if (!options?.preview) {
            await waitImages(document);
            try {
                window.print();
            } catch {}
            if (options?.autoClose !== false) {
                window.addEventListener('afterprint', () => teardown(), { once: true });
            }
        }
    }

    return { printReceipt, setDefaultProfile, setDefaultCurrencyFormatter };
}

/* ============================ Util garis-char ========================== */

function defaultCharCols(widthMm: number): number {
    if (widthMm <= 60) return 32; // 57/58mm
    if (widthMm <= 90) return 48; // 80mm
    if (widthMm <= 120) return 64; // 110mm
    return 72;
}
function makeCharLine(c: '_' | '-', cols: number): string {
    const n = Math.max(6, Math.min(200, cols));
    return c.repeat(n);
}

/* ============================ Renderers ================================ */

function renderAutoLayout(args: { data: ReceiptData; profile: PrintProfile; currency: CurrencyFormat; options?: PrintOptions }) {
    const { data, profile, currency, options } = args;
    return isThermal(profile) ? renderThermal(data, currency, options?.thermalColumns, options) : renderRegular(data, currency, options);
}

/* -------- Thermal (57/58/80/110) -------------------------------------- */

function renderThermal(
    data: ReceiptData,
    currency: CurrencyFormat,
    columns: PrintOptions['thermalColumns'] = ['qty', 'total'],
    opts?: PrintOptions,
): string {
    const { header, items, totals, footer, customBlocks } = data;
    const title = header?.title ?? 'PAYMENT RECEIPT';
    const qtyFmt: QtyFormat = opts?.qtyFormat ?? '(xN)';

    const renderHeader = () => `
    ${header?.logoUrl ? `<div class="center"><img src="${header.logoUrl}" alt="logo" class="logo"/></div>` : ''}
    <div class="h1 center">${renderSegments(header?.companyName || '')}</div>
    <div class="center sub">${renderSegments(title)}</div>
    ${header?.address ? `<div class="muted center mt2">${escapeHtml(header.address)}</div>` : ''}
    <div class="rule double"></div>
    ${header?.meta ? `<div class="therm-kv">${renderKv(header.meta, 'kv-therm')}</div>` : ''}
    <div class="rule dashed"></div>
  `;

    const renderItems = () => {
        if (!items?.length) return '';
        const showPrice = columns.includes('price');
        const showTotal = columns.includes('total');

        const rows = items
            .map((it, idx) => {
                const qty = typeof it.qty === 'number' ? it.qty : undefined;
                const price = it.price ?? 0;
                const total = it.total ?? (qty ? qty * price : price);

                const inlineQty = typeof qty === 'number' ? `<span class="i-qty">${formatQty(qty, qtyFmt)}</span>` : '';

                const meta: string[] = [];
                if (showPrice) meta.push(currency(price));
                if (showTotal) meta.push(currency(total));

                return `
        <div class="t-row" data-item-idx="${idx}">
          <div class="t-left">
            <div class="i-name">${escapeHtml(it.name)}${inlineQty}</div>
            ${it.note ? `<div class="i-note">${escapeHtml(it.note)}</div>` : ''}
            ${meta.length ? `<div class="i-meta">${meta.map(escapeHtml).join(' · ')}</div>` : ''}
          </div>
          <div class="t-total">${currency(total)}</div>
        </div>`;
            })
            .join('');

        return `<div class="t-items">${rows}</div>`;
    };

    const renderTotals = () => {
        if (!totals?.length) return '';
        const rows = totals
            .map((t) => {
                const cls = `${t.isBold ? 'bold' : ''} ${t.className || ''}`.trim();
                return `<div class="row ${cls}" data-total-label="${escapeAttr(plainTextFromSegments(t.label))}">
                          <div class="total-l">${renderSegments(t.label)}</div>
                          <div class="total-v">${renderSegments(t.value)}</div>
                        </div>`;
            })
            .join('');
        return `<div class="rule dashed"></div><div class="totals">${rows}</div>`;
    };

    const renderBlocks = () => {
        if (!customBlocks?.length) return '';
        return customBlocks
            .map((b) => {
                if (b.kind === 'text')
                    return `<div class="blk-txt ${b.bold ? 'b' : ''} ${b.small ? 's' : ''} ${b.align || 'left'}">${escapeHtml(b.text)}</div>`;
                if (b.kind === 'hr') return `<div class="rule ${b.style || 'dashed'}"></div>`;
                if (b.kind === 'spacer') return `<div style="height:${Math.max(2, Math.min(32, Number(b.size || 8)))}px"></div>`;
                if (b.kind === 'kv') {
                    const w = Math.max(16, Math.min(60, Number(b.labelWidthMm || 24)));
                    const rows = b.rows
                        .map(
                            (r) =>
                                `<div class="kv-row"><div class="kv-l">${escapeHtml(r.label)}</div><div class="kv-v">${escapeHtml(r.value)}</div></div>`,
                        )
                        .join('');
                    return `<div class="kv-free" style="--lw:${w}mm">${rows}</div>`;
                }
                if (b.kind === 'box') {
                    const lines = b.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
                    return `<div class="box ${b.align || 'center'}">${lines}</div>`;
                }
                if (b.kind === 'line') {
                    const profile = (opts?.profile || 'thermal-58') as PrintProfile;
                    const widthMm = opts?.paperWidthMm || mmFromProfile(profile);
                    const c = b.char || '_';
                    const count = b.repeat ?? opts?.charCols ?? defaultCharCols(widthMm);
                    const align = b.align || 'left';
                    return `<div class="char-line ${align}">${makeCharLine(c, count)}</div>`;
                }
                return '';
            })
            .join('');
    };

    return `${renderHeader()}${renderItems()}${renderTotals()}${renderCodes(data)}${renderBlocks()}${renderFooter(footer)}`;
}

/* -------- Regular (A/Letter/Legal/F4) --------------------------------- */

function renderRegular(data: ReceiptData, currency: CurrencyFormat, opts?: PrintOptions): string {
    const { header, items, totals, footer, customBlocks } = data;
    const title = header?.title ?? 'INVOICE';
    const accent = opts?.accentColor || '#111827';
    const qtyFmt: QtyFormat = opts?.qtyFormat ?? '(xN)';
    const showInlineQty = opts?.regularShowInlineQty === true;

    const renderHeader = () => `
    <div class="header-grid">
      <div class="brand">
        ${header?.logoUrl ? `<img src="${header.logoUrl}" class="logo" alt="logo"/>` : ''}
        <div class="brand-text">
          <div class="company-name">${renderSegments(header?.companyName || '')}</div>
          ${header?.address ? `<div class="muted">${escapeHtml(header.address)}</div>` : ''}
        </div>
      </div>
      <div class="title-area">
        <div class="h1" style="color:${accent}">${renderSegments(title)}</div>
        ${header?.meta ? renderKv(header.meta, 'meta-grid') : ''}
      </div>
    </div>
    <div class="hr-line"></div>`;

    const renderItems = () => {
        if (!items?.length) return '';
        const head = `<thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead>`;
        const rows = items
            .map((it, idx) => {
                const qty = typeof it.qty === 'number' ? it.qty : undefined;
                const price = it.price ?? 0;
                const total = it.total ?? (qty ? qty * price : price);
                const inlineQty = showInlineQty && typeof qty === 'number' ? `<span class="item-qty-inline">${formatQty(qty, qtyFmt)}</span>` : '';
                return `<tr data-item-idx="${idx}">
        <td>
          <div class="item-name">${escapeHtml(it.name)} ${inlineQty}</div>
          ${it.note ? `<div class="muted item-note">${escapeHtml(it.note)}</div>` : ''}
        </td>
        <td class="right">${qty ?? ''}</td>
        <td class="right">${currency(price)}</td>
        <td class="right strong">${currency(total)}</td>
      </tr>`;
            })
            .join('');
        return `<table class="items">${head}<tbody>${rows}</tbody></table>`;
    };

    const renderTotalsAndCodes = () => {
        if (!totals?.length && !data.qrcode && !data.barcode && !customBlocks?.length) return '';
        const rows =
            totals
                ?.map((t) => {
                    const cls = `${t.isBold ? 'bold' : ''} ${t.className || ''}`.trim();
                    return `<div class="row ${cls}" data-total-label="${escapeAttr(plainTextFromSegments(t.label))}">
                              <div>${renderSegments(t.label)}</div>
                              <div class="right">${renderSegments(t.value)}</div>
                            </div>`;
                })
                .join('') || '';

        const blocks = (customBlocks || [])
            .map((b) => {
                if (b.kind === 'text')
                    return `<div class="blk-txt ${b.bold ? 'b' : ''} ${b.small ? 's' : ''} ${b.align || 'left'}">${escapeHtml(b.text)}</div>`;
                if (b.kind === 'hr') return `<div class="hr-line ${b.style || 'dashed'}"></div>`;
                if (b.kind === 'spacer') return `<div style="height:${Math.max(2, Math.min(48, Number(b.size || 8)))}px"></div>`;
                if (b.kind === 'kv') {
                    const w = Math.max(30, Math.min(100, Number(b.labelWidthMm || 40)));
                    const rr = b.rows
                        .map(
                            (r) =>
                                `<div class="kv-row"><div class="kv-l">${escapeHtml(r.label)}</div><div class="kv-v">${escapeHtml(r.value)}</div></div>`,
                        )
                        .join('');
                    return `<div class="kv-free-regular" style="--lw:${w}mm">${rr}</div>`;
                }
                if (b.kind === 'box') {
                    const lines = b.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
                    return `<div class="box-regular ${b.align || 'left'}">${lines}</div>`;
                }
                if (b.kind === 'line') {
                    const widthMm = opts?.paperWidthMm ?? 210;
                    const c = b.char || '_';
                    const count = b.repeat ?? opts?.charCols ?? defaultCharCols(widthMm);
                    const align = b.align || 'left';
                    return `<div class="char-line ${align}">${makeCharLine(c, count)}</div>`;
                }
                return '';
            })
            .join('');

        return `
      <div class="summary-grid">
        <div class="codes">${renderCodes(data, 120)}</div>
        <div class="totals">${rows}</div>
      </div>
      ${blocks}
    `;
    };

    return `<div class="card"><div class="card-body">
    ${renderHeader()}${renderItems()}${renderTotalsAndCodes()}${renderFooter(footer)}
  </div></div>`;
}

/* ====================== In-place mounting (no popup) =================== */

async function mountInPlace(bodyHtml: string, profile: PrintProfile, options?: PrintOptions) {
    const target = resolveMountTarget(options?.mountTarget);
    const css = buildCss(profile, options, true);
    const id = 'dp-print-root-' + Math.random().toString(36).slice(2);

    const root = document.createElement('div');
    root.id = id;
    root.className = 'dp-print-root' + (options?.overlay !== false ? ' dp-overlay' : '');

    const style = document.createElement('style');
    style.appendChild(document.createTextNode(css));

    const controls = document.createElement('div');
    controls.className = 'dp-controls';
    if (options?.showControls !== false) {
        controls.innerHTML = `
      <div class="dp-controls-bar">
        <button class="dp-btn dp-print">Print</button>
        <button class="dp-btn dp-close">Close</button>
      </div>`;
    }

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = bodyHtml;

    root.appendChild(style);
    root.appendChild(controls);
    root.appendChild(sheet);
    target.appendChild(root);

    const onClose = () => {
        try {
            root.remove();
        } catch {}
    };
    const onPrint = async () => {
        await waitImages(root);
        try {
            window.print();
        } catch {}
    };

    (controls.querySelector('.dp-close') as HTMLButtonElement | null)?.addEventListener('click', onClose);
    (controls.querySelector('.dp-print') as HTMLButtonElement | null)?.addEventListener('click', onPrint);

    return () => onClose();
}

function resolveMountTarget(target?: string | Element): Element {
    if (!target) return document.body;
    if (typeof target === 'string') return document.querySelector(target) || document.body;
    return target;
}

async function waitImages(scope: Document | Element) {
    const imgs = Array.from(scope.querySelectorAll('img'));
    await Promise.all(
        imgs.map((img) =>
            img.complete
                ? Promise.resolve(true)
                : new Promise((res) => {
                      img.onload = img.onerror = () => res(true);
                  }),
        ),
    );
}

/* ============================ CSS (screen+print) ======================= */

type Size = { w: number; h: number };
const REG_SIZES_MM: Record<Exclude<PrintProfile, 'custom' | 'thermal-57' | 'thermal-58' | 'thermal-80' | 'thermal-110'>, Size> = {
    'regular-A3': { w: 297, h: 420 },
    'regular-A4': { w: 210, h: 297 },
    'regular-A5': { w: 148, h: 210 },
    'regular-Letter': { w: 216, h: 279 },
    'regular-Legal': { w: 216, h: 356 },
    'regular-F4': { w: 210, h: 330 },
};

function pageSizeCss(profile: PrintProfile, o: PrintOptions | undefined) {
    if (isThermal(profile)) {
        const w = o?.paperWidthMm || mmFromProfile(profile);
        return `@page { size: ${w}mm auto; margin: 0; }`;
    }
    if (profile === 'custom') {
        const w = o?.paperWidthMm ?? 210;
        const h = o?.paperHeightMm ?? 297;
        return `@page { size: ${w}mm ${h}mm; margin: ${o?.marginMm ?? 12}mm; }`;
    }
    const { w, h } = REG_SIZES_MM[profile as keyof typeof REG_SIZES_MM] || { w: 210, h: 297 };
    const landscape = (o?.orientation || 'portrait') === 'landscape';
    const W = landscape ? h : w,
        H = landscape ? w : h;
    const margin = o?.marginMm ?? 12;
    return `@page { size: ${W}mm ${H}mm; margin: ${margin}mm; }`;
}

function buildCss(profile: PrintProfile, options?: PrintOptions, inplace = false): string {
    const isTherm = isThermal(profile);
    const page = pageSizeCss(profile, options);
    const paperWidthMm = options?.paperWidthMm || (isTherm ? mmFromProfile(profile) : 210);
    const marginMm = options?.marginMm ?? (isTherm ? 2.5 : 12);
    const density = options?.density || (isTherm ? 'compact' : 'regular');
    const accent = options?.accentColor || '#111827';

    const overrides = options?.cssOverrides ? (Array.isArray(options.cssOverrides) ? options.cssOverrides.join('\n') : options.cssOverrides) : '';

    const base = `
  ${page}
  html, body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { margin:0 auto; page-break-inside:avoid; }
  ${
      inplace
          ? `
    @media screen {
      .dp-print-root.dp-overlay { 
        position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.35);
        display:flex; flex-direction:column; align-items:center; justify-content:flex-start; 
        gap:12px; padding:24px 12px; box-sizing:border-box; overflow-y:auto; 
      }
      .dp-controls-bar { 
        position:relative;
        display:flex; gap:8px;
        background:#111827; color:#fff; border-radius:999px; padding:6px 10px; 
        box-shadow:0 8px 24px rgba(0,0,0,.2);
        flex-shrink: 0;
      }
      .dp-btn { background:rgba(255,255,255,.12); border:0; color:#fff; font-weight:600; border-radius:999px; padding:6px 10px; cursor:pointer; }
      .dp-btn:hover { background:rgba(255,255,255,.2); }
    }
    @media print {
      body > :not(.dp-print-root) { display: none !important; }
      .dp-controls { display: none !important; }
      .dp-print-root { position: static !important; inset: auto !important; background: none !important;
                       display: block !important; padding: 0 !important; }
    }
  `
          : ''
  }

  .center { text-align:center; }
  .right  { text-align:right; }
  .strong { font-weight:600; }
  .bold   { font-weight:700; }
  .muted  { color:#6b7280; }
  img { max-width:100%; height:auto; display:block; }
  .char-line { white-space: pre; font-family: inherit; line-height: 1; margin: 4px 0; }
  .char-line.center { text-align: center; }
  .char-line.right  { text-align: right; }

  /* ➕ util untuk segmen styled */
  .seg { display:inline; }
  `;

    if (isTherm) {
        const fz = density === 'compact' ? '9pt' : '10pt';
        return (
            base +
            `
      .dp-print-root { font-family:'Courier New', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:${fz}; line-height:1.45; color:#111; }
      .sheet { width:${paperWidthMm}mm; padding:${marginMm}mm; box-sizing:border-box; background:#fff; padding-top:1.5rem; padding-bottom:1.5rem; }
      .logo { max-height:38px; margin:0 auto 6px; filter: grayscale(1) contrast(150%); }
      .h1 { font-size:10pt; font-weight:700; text-transform:uppercase; letter-spacing:.2px; }
      .sub { font-size:8.5pt; letter-spacing:.4px; color:#333; text-transform:uppercase; }
      .mt2 { margin-top:4px; }

      .rule { height:0; border-top:1px solid #c7c7c7; margin:6px 0; }
      .rule.dashed { border-top:1px dashed #c7c7c7; }
      .rule.double { border-top:3px double #111; }

      .therm-kv { margin-top:6px; }
      /* tambah class pada cell untuk target CSS yang spesifik via [data-k] */
      .kv-therm { display:grid; grid-template-columns: 22mm 1fr; gap:2px 6px; }
      .kv-therm > .kv-l { color:#6b7280; }
      .kv-therm > .kv-v { text-align:right; word-break:break-word; }

      .t-items { margin-top:6px; }
      .t-row { display:grid; grid-template-columns: 1fr auto; gap:2px 8px; padding:1px 0; }
      .i-name { font-weight:700; }
      .i-qty { margin-left:4px; font-weight:400; font-size:7pt; color:#374151; }
      .i-note { font-size:6pt; color:#444; margin-top:-5px;}
      .i-meta { font-size:8.5pt; color:#333; }
      .t-total { text-align:right; font-weight:600; white-space:nowrap; }

      .totals { margin-top:6px; }
      .totals .row { display:grid; grid-template-columns:1fr auto; gap:2px 8px; padding:2px 0; }
      .totals .row.bold { font-weight:700; font-size:10pt; }

      .codes-container { display:flex; flex-direction:column; align-items:center; gap:8px; margin:8px 0 0; }
      .code-item { display:grid; place-items:center; gap:4px; font-size:8.5pt; color:#333; }
      .code-item img { display:block; }

      .blk-txt { margin:2px 0; }
      .blk-txt.b { font-weight:700; }
      .blk-txt.s { font-size:8pt; }
      .blk-txt.center { text-align:center; }
      .blk-txt.right { text-align:right; }

      .kv-free { display:grid; grid-template-columns: var(--lw,24mm) 1fr; gap:2px 6px; margin:4px 0; }
      .kv-row .kv-l { color:#6b7280; }
      .kv-row .kv-v { text-align:right; word-break:break-word; }

      .box { border:1px dashed #c7c7c7; border-radius:4px; padding:6px; margin-top:6px; }
      .box.center { text-align:center; }
      .box.right  { text-align:right; }

      .footer { text-align:center; margin-top:10px; margin-bottom:1rem; padding-top:6px; border-top:1px solid #e5e7eb; color:#6b7280; white-space:pre-wrap; font-size:8.5pt; }

      ${overrides}
    `
        );
    }

    // Regular (A/Letter/Legal/F4)
    return (
        base +
        `
    .dp-print-root { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif; font-size:10pt; color:#111827; }
    .sheet { width:100%; background:#fff; }
    .card { border:1px solid #e5e7eb; border-radius:8px; background:#fff; }
    .card-body { padding:20px; }
    .header-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:12px; }
    .brand { display:flex; gap:12px; align-items:flex-start; }
    .logo { height:46px; }
    .company-name { font-size:16pt; font-weight:700; }
    .title-area { text-align:right; }
    .h1 { font-size:20pt; font-weight:700; margin-bottom:6px; }
    .meta-grid { display:grid; grid-template-columns:auto auto; justify-content:flex-end; gap:4px 16px; font-size:9pt; }
    .meta-grid > .kv-l { color:#6b7280; }
    .meta-grid > .kv-v { text-align:right; }
    .hr-line { border-top:1px solid #e5e7eb; margin:6px 0 10px; }
    .hr-line.dashed { border-top:1px dashed #c7c7c7; }
    .hr-line.double { border-top:3px double ${accent}; }

    .items { width:100%; border-collapse:collapse; margin-top:8px; }
    .items th, .items td { padding:8px 6px; border-bottom:1px solid #e5e7eb; vertical-align:top; }
    .items th { text-align:left; font-weight:600; background:#f9fafb; }
    .item-name { font-weight:600; }
    .item-qty-inline { font-weight:400; font-size:9pt; color:#374151; } /* ➕ optional qty inline di regular */
    .item-note { font-size:9pt; }

    .summary-grid { display:grid; grid-template-columns: 1fr minmax(180px, 28%); gap:16px; margin-top:16px; align-items:start; }
    .codes { padding-right:8px; }
    .totals { border-top:2px solid ${accent}; padding-top:8px; }
    .totals .row { display:grid; grid-template-columns:1fr auto; gap:6px; padding:2px 0; }
    .totals .row.bold { font-size:13pt; font-weight:700; }

    .blk-txt { margin:4px 0; }
    .blk-txt.b { font-weight:700; }
    .blk-txt.s { font-size:9pt; }
    .blk-txt.center { text-align:center; }
    .blk-txt.right { text-align:right; }

    .kv-free-regular { display:grid; grid-template-columns: var(--lw,40mm) 1fr; gap:4px 10px; margin:8px 0; }
    .kv-free-regular .kv-l { color:#6b7280; }
    .kv-free-regular .kv-v { text-align:right; }

    .box-regular { border:1px dashed #d1d5db; border-radius:6px; padding:10px; margin-top:10px; }
    .box-regular.center { text-align:center; }
    .box-regular.right  { text-align:right; }

    .footer { text-align:center; margin-top:12px; padding-top:8px; border-top:1px solid #e5e7eb; color:#6b7280; white-space:pre-wrap; }

    ${overrides}
  `
    );
}

/* ============================== Helpers ================================ */

function escapeHtml(s: unknown): string {
    const str = String(s ?? '');
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return str.replace(/[&<>"']/g, (m) => map[m]);
}
function escapeAttr(s: unknown): string {
    return String(s ?? '').replace(/"/g, '&quot;');
}

function renderKv(meta?: Record<string, MetaValue>, cssClass = ''): string {
    if (!meta) return '';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(meta)) {
        parts.push(
            `<div class="kv-l" data-k="${escapeAttr(k)}">${escapeHtml(k)}</div>` +
                `<div class="kv-v" data-k="${escapeAttr(k)}">${renderSegments(v)}</div>`,
        );
    }
    return `<div class="${cssClass}">${parts.join('')}</div>`;
}

/** Styled segmen renderer (string | segmen | segmen[]) */
function renderSegments(v: string | StyledTextSegment | StyledTextSegment[] | undefined): string {
    if (v == null) return '';
    if (typeof v === 'string') return escapeHtml(v);
    const segs = Array.isArray(v) ? v : [v];
    return segs
        .map((s) => {
            const cls = s.className ? ` class="seg ${escapeAttr(s.className)}"` : ` class="seg"`;
            const st = s.style ? ` style="${escapeAttr(s.style)}"` : '';
            return `<span${cls}${st}>${escapeHtml(s.text)}</span>`;
        })
        .join('');
}

function plainTextFromSegments(v: string | StyledTextSegment | StyledTextSegment[] | undefined): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    const segs = Array.isArray(v) ? v : [v];
    return segs.map((s) => s.text).join('');
}

function isThermal(p: PrintProfile): boolean {
    return p.startsWith('thermal-');
}
function mmFromProfile(p: PrintProfile): number {
    if (!isThermal(p)) return 210;
    const v = parseInt(p.split('-')[1], 10);
    return isNaN(v) ? 58 : v; // thermal-57/58/80/110
}

function formatQty(qty: number, fmt: QtyFormat): string {
    const n = String(Math.max(0, qty));
    switch (fmt) {
        case 'xN':
            return `x${n}`;
        case 'Nx':
            return `${n}x`;
        case '(Nx)':
            return `(${n}x)`;
        case '(xN)':
        default:
            return `(x${n})`;
    }
}

function renderCodes(d?: ReceiptData, size = 80): string {
    if (!d || (!d.qrcode && !d.barcode)) return '';
    const parts: string[] = [];
    if (d.qrcode?.data) {
        const src = d.qrcode.data.trim();
        const isDataUrl = /^data:image\/(png|svg\+xml);/i.test(src) || /^https?:\/\//i.test(src);
        const imgSrc = src.startsWith('<svg') ? svgToDataUrl(src) : src;
        parts.push(
            isDataUrl || src.startsWith('<svg')
                ? `<div class="code-item"><img src="${imgSrc}" alt="QR" style="width:${size}px;height:${size}px;object-fit:contain"/><span>${escapeHtml(
                      d.qrcode.caption || '',
                  )}</span></div>`
                : `<div class="code-item muted">QR unavailable<span>${escapeHtml(d.qrcode.caption || '')}</span></div>`,
        );
    }
    if (d.barcode?.data) {
        parts.push(`<div class="code-item">${generateBarcodeSvg(d.barcode.data)}<span>${escapeHtml(d.barcode.caption || '')}</span></div>`);
    }
    return `<div class="codes-container">${parts.join('')}</div>`;
}

function renderFooter(footer?: { lines?: string[] }): string {
    if (!footer?.lines?.length) return '';
    return `<div class="footer">${footer.lines.map((l) => escapeHtml(l)).join('<br>')}</div>`;
}

function svgToDataUrl(svg: string): string {
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Code 128 (subset B) as SVG (no deps) */
function generateBarcodeSvg(data: string): string {
    const START_B = 104,
        STOP = 106;
    const CODES = [
        '212222',
        '222122',
        '222221',
        '121223',
        '121322',
        '131222',
        '122213',
        '122312',
        '132212',
        '221213',
        '221312',
        '231212',
        '112232',
        '122132',
        '122231',
        '113222',
        '123122',
        '123221',
        '223211',
        '221132',
        '221231',
        '213212',
        '223112',
        '312131',
        '311222',
        '321122',
        '321221',
        '312212',
        '322112',
        '322211',
        '212123',
        '212321',
        '232121',
        '111323',
        '131123',
        '131321',
        '112313',
        '132113',
        '132311',
        '211313',
        '231113',
        '231311',
        '112133',
        '112331',
        '132131',
        '113123',
        '113321',
        '133121',
        '313121',
        '211331',
        '231131',
        '213113',
        '213311',
        '213131',
        '311123',
        '311321',
        '331121',
        '312113',
        '312311',
        '332111',
        '314111',
        '221411',
        '413111',
        '111224',
        '111422',
        '121124',
        '121421',
        '141122',
        '141221',
        '112214',
        '112412',
        '122114',
        '122411',
        '142112',
        '142211',
        '241211',
        '221114',
        '412112',
        '421112',
        '241112',
        '134111',
        '111242',
        '121142',
        '121241',
        '114212',
        '124112',
        '124211',
        '411212',
        '421112',
        '421211',
        '212141',
        '214121',
        '412121',
        '111143',
        '111341',
        '131141',
        '114113',
        '114311',
        '411113',
        '411311',
        '113141',
        '114131',
        '311141',
        '411131',
        '211412',
        '211214',
        '211232',
        '2331112',
    ];
    let sum = START_B;
    const code: number[] = [START_B];
    for (let i = 0; i < data.length; i++) {
        const cc = data.charCodeAt(i);
        const idx = cc > 95 ? cc - 64 : cc - 32;
        sum += idx * (i + 1);
        code.push(idx);
    }
    code.push(sum % 103, STOP);

    let bars = '';
    let x = 0;
    for (const c of code) {
        const pattern = CODES[c];
        for (let i = 0; i < 6; i++) {
            const w = parseInt(pattern[i], 10);
            if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="60" fill="black"/>`;
            x += w;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="60" viewBox="0 0 ${x} 60" style="shape-rendering:crispEdges;">${bars}</svg>`;
}
