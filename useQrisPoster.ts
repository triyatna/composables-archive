/*
|--------------------------------------------------------------------------
| useQrisPoster.ts
|--------------------------------------------------------------------------
| Version: 1.2 
*/

import QrcodeVue from 'qrcode.vue';
import { createApp, defineComponent, h, nextTick } from 'vue';

/* -------------------------------- Types --------------------------------- */
export type QrPattern = 'none' | 'dots' | 'grid' | 'diagonal' | 'waves' | 'triangles' | 'scribble';
export type QrisPosterTemplate = 'default' | 'modern' | 'elegant' | 'corporate';

export interface QrisPosterTheme {
    primary: string;
    primaryDark: string;
    pageBg: string;
    cardBg: string;
    text: string;
    textMuted: string;
    qrDark: string;
    qrLight: string;
    qrGradient?: {
        color1: string;
        color2: string;
        type?: 'linear' | 'radial';
        rotation?: number;
    };
    pattern: QrPattern;
    patternOpacity: number;
    accentShapes?: boolean;
    accentShapeColor1?: string;
    accentShapeColor2?: string;
    techPatternColor?: string;
}

export interface QrisPosterSize {
    width: number;
    height: number;
    qrSize: number;
    quietZone: number;
    headerHeight: number;
    footerHeight: number;
    padding: number;
    cardPadding: number;
    cardRadius: number;
    scale: number;
}

export interface QrisPosterText {
    appName: string;
    title: string;
    caption: string;
    invoiceReference?: string;
    watermark?: string;
    footerText?: string;
}

export interface BuildQrisPosterOptions {
    template?: QrisPosterTemplate;
    theme?: Partial<QrisPosterTheme>;
    size?: Partial<QrisPosterSize>;
    text?: Partial<QrisPosterText>;
    qrCanvas?: HTMLCanvasElement | null;
    logo?: HTMLImageElement | null;
    ecLevel?: 'L' | 'M' | 'Q' | 'H';
    fileName?: string;
}

export interface ParsedQris {
    raw: string;
    tlv: Record<string, any>;
    merchantName?: string;
    merchantId?: string;
    merchantCity?: string;
    currency?: string;
    amount?: string;
    invoiceReference?: string;
    validCrc?: boolean;
}

/* ----------------------------- Constants & Defaults --------------------------------- */
const QRIS_LOGO_URL = 'https://xendit.co/wp-content/uploads/2020/03/iconQris.png';
const QR_STYLING_LIB_URL = 'https://cdn.jsdelivr.net/npm/qr-code-styling@1.6.0-rc.1/lib/qr-code-styling.js';

const DEFAULT_THEME: QrisPosterTheme = {
    primary: '#4F46E5',
    primaryDark: '#4338CA',
    pageBg: '#F3F4F6',
    cardBg: '#FFFFFF',
    text: '#111827',
    textMuted: '#6B7280',
    qrDark: '#000000',
    qrLight: '#FFFFFF',
    pattern: 'none',
    patternOpacity: 0.8,
    accentShapes: true,
};

const DEFAULT_SIZE: QrisPosterSize = {
    width: 960,
    height: 0,
    qrSize: 512,
    quietZone: 32,
    headerHeight: 160,
    footerHeight: 96,
    padding: 40,
    cardPadding: 40,
    cardRadius: 16,
    scale: Math.min(3, Math.max(1, Math.floor((globalThis.devicePixelRatio || 1) + 0.5))),
};

const DEFAULT_TEXT: QrisPosterText = {
    appName: 'Detopupin',
    title: 'QRIS',
    caption: 'Scan to Pay',
    invoiceReference: undefined,
    watermark: 'Powered by Detopupin',
};

/* ----------------------------- Composable (Main Logic) -------------------------------- */
export function useQrisPoster() {
    async function buildQrisPosterDataUrl(qrisString: string, opts?: BuildQrisPosterOptions): Promise<string> {
        const canvas = await buildQrisPosterCanvas(qrisString, opts);
        return canvas.toDataURL('image/png');
    }

    async function buildQrisPosterBlob(qrisString: string, opts?: BuildQrisPosterOptions): Promise<Blob> {
        const canvas = await buildQrisPosterCanvas(qrisString, opts);
        return new Promise((resolve) => canvas.toBlob((b) => resolve(b || new Blob()), 'image/png'));
    }

    async function buildQrisPosterCanvas(qrisString: string, opts?: BuildQrisPosterOptions): Promise<HTMLCanvasElement> {
        const parsed = parseQrisTLV(qrisString);
        const template = opts?.template || 'modern';
        const theme = mergeTheme(opts?.theme);
        const size = mergeSize(opts?.size);
        const text = mergeText(opts?.text);
        const ecLevel = opts?.ecLevel || 'H';

        const qrCanvas = opts?.qrCanvas || (await renderQrCanvas(qrisString, size.qrSize, theme, ecLevel));
        if (!qrCanvas) {
            throw new Error('Failed to render QR canvas');
        }

        const qrisLogo = ['modern', 'corporate'].includes(template) ? await loadImage(QRIS_LOGO_URL) : null;

        return await composePoster({ parsed, qrCanvas, theme, size, text, logo: opts?.logo || null, template, qrisLogo });
    }

    async function downloadQrisPoster(qrisString: string, opts?: BuildQrisPosterOptions): Promise<void> {
        try {
            const dataUrl = await buildQrisPosterDataUrl(qrisString, opts);
            const name = sanitizeFileName(opts?.fileName || suggestFileName(qrisString, opts?.text));
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = name + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (error) {
            console.error('Failed to download QRIS poster:', error);
            alert('Sorry, there was an error creating the QRIS poster. Please try again.');
        }
    }

    return { buildQrisPosterDataUrl, buildQrisPosterBlob, buildQrisPosterCanvas, downloadQrisPoster, parseQrisTLV };
}

/* ----------------------------- QR Rendering ------------------------------ */
async function renderQrCanvas(
    value: string,
    size: number,
    theme: QrisPosterTheme,
    ecLevel: 'L' | 'M' | 'Q' | 'H',
): Promise<HTMLCanvasElement | null> {
    try {
        await loadScript(QR_STYLING_LIB_URL);
        const QRCodeStyling = (window as any).QRCodeStyling;
        if (!QRCodeStyling) throw new Error('QRCodeStyling library not found on window');

        const qrCode = new QRCodeStyling({
            width: size,
            height: size,
            data: value,
            margin: 0,
            qrOptions: {
                errorCorrectionLevel: ecLevel,
            },
            backgroundOptions: {
                color: theme.qrLight,
            },
        });

        const canvas = (await qrCode.getRawData('canvas')) as HTMLCanvasElement;
        return canvas;
    } catch (e) {
        console.error('Advanced QR rendering failed, falling back to basic renderer.', e);
        return renderQrCanvasFallback(value, size, theme.qrDark, theme.qrLight, ecLevel);
    }
}

async function renderQrCanvasFallback(
    value: string,
    size: number,
    dark: string,
    light: string,
    ecLevel: 'L' | 'M' | 'Q' | 'H',
): Promise<HTMLCanvasElement | null> {
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;';
    document.body.appendChild(container);

    let canvasEl: HTMLCanvasElement | null = null;

    const App = defineComponent({
        name: 'QrMount',
        render() {
            return h(QrcodeVue as any, {
                value,
                size,
                level: ecLevel,
                renderAs: 'canvas',
                background: light,
                foreground: dark,
                margin: 0,
                ref: 'qr',
            });
        },
        mounted() {
            const root = this.$refs.qr as any;
            canvasEl = root?.$el?.tagName === 'CANVAS' ? (root.$el as HTMLCanvasElement) : null;
        },
    });

    const app = createApp(App);
    app.mount(container);
    await nextTick();

    let result: HTMLCanvasElement | null = null;
    if (canvasEl) {
        const clone = document.createElement('canvas');
        clone.width = size;
        clone.height = size;
        const ctx = clone.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(canvasEl, 0, 0, size, size);
            result = clone;
        }
    }

    try {
        app.unmount();
        container.remove();
    } catch {}

    return result;
}

/* -------------------------- Poster Composition -------------------------- */
interface ComposeArgs {
    parsed: ParsedQris;
    qrCanvas: HTMLCanvasElement;
    theme: QrisPosterTheme;
    size: QrisPosterSize;
    text: QrisPosterText;
    logo: HTMLImageElement | null;
    template: QrisPosterTemplate;
    qrisLogo: HTMLImageElement | null;
}

async function composePoster(args: ComposeArgs): Promise<HTMLCanvasElement> {
    switch (args.template) {
        case 'modern':
            return await composeModernPoster(args);
        case 'elegant':
            return await composeElegantPoster(args);
        case 'corporate':
            return await composeCorporatePoster(args);
        case 'default':
        default:
            return await composeDefaultPoster(args);
    }
}

async function composeModernPoster(args: ComposeArgs): Promise<HTMLCanvasElement> {
    const { parsed, qrCanvas, theme, size, text, logo, qrisLogo } = args;
    const width = Math.max(720, size.width);
    const estHeight = width * 1.35;
    const height = size.height > 0 ? size.height : estHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width * size.scale;
    canvas.height = height * size.scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(size.scale, size.scale);

    /* --- Latar Belakang & Pola Dasar (Lapisan 1-3) --- */
    ctx.fillStyle = theme.pageBg;
    ctx.fillRect(0, 0, width, height);

    drawTechShapes(ctx, width, height, theme);
    drawPattern(ctx, theme, 0, 0, width, height);

    /* --- Bentuk Aksen (Lapisan 4: di atas pola, di bawah kartu) --- */
    if (theme.accentShapes) {
        drawModernAccentShapes(ctx, width, height, theme);
    }

    /* --- Konten Header --- */
    let currentY = size.padding * 1.5;
    if (qrisLogo) {
        const logoHeight = 100;
        const logoWidth = (qrisLogo.width / qrisLogo.height) * logoHeight;
        ctx.drawImage(qrisLogo, (width - logoWidth) / 2, currentY, logoWidth, logoHeight);
        currentY += logoHeight + 55;
    }

    ctx.textAlign = 'center';
    if (parsed.merchantName) {
        ctx.font = '700 38px Inter, system-ui, sans-serif';
        ctx.fillStyle = theme.text;
        ctx.fillText(parsed.merchantName, width / 2, currentY);
        currentY += 48;
    }

    ctx.font = '500 21px Inter, system-ui, sans-serif';
    ctx.fillStyle = theme.textMuted;
    if (parsed.merchantId) {
        ctx.fillText(`NMID: ${parsed.merchantId}`, width / 2, currentY);
        currentY += 30;
    }
    if (parsed.merchantCity) {
        ctx.fillText(parsed.merchantCity, width / 2, currentY);
        currentY += 45;
    }

    /* --- Kartu QR (Lapisan 5: di atas semua elemen grafis) --- */
    const qrBoxSize = width * 0.7;
    const qrBoxX = (width - qrBoxSize) / 2;
    drawRoundedRect(ctx, qrBoxX, currentY, qrBoxSize, qrBoxSize, size.cardRadius);
    ctx.fillStyle = theme.cardBg;
    ctx.shadowColor = 'rgba(0,0,0,0.08)';
    ctx.shadowBlur = 25;
    ctx.shadowOffsetY = 5;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    const qrActualSize = qrBoxSize - size.cardPadding * 2;
    const qrX = qrBoxX + size.cardPadding;
    const qrY = currentY + size.cardPadding;
    ctx.drawImage(qrCanvas, qrX, qrY, qrActualSize, qrActualSize);
    if (logo) drawLogoOnQr(ctx, logo, qrX, qrY, qrActualSize, theme.qrLight);

    currentY += qrBoxSize + 28;

    /* --- Teks & Watermark (Lapisan Paling Atas) --- */
    ctx.font = '600 24px Inter, system-ui, sans-serif';
    ctx.fillStyle = theme.text;
    ctx.fillText(text.caption || 'Scan to pay', width / 2, currentY);
    currentY += 28;

    const inferredRef = text.invoiceReference || parsed.invoiceReference;
    if (inferredRef) {
        ctx.font = '700 18px Inter, system-ui, sans-serif';
        ctx.fillStyle = theme.textMuted;
        ctx.fillText(`No. Invoice: ${inferredRef}`, width / 2, currentY);
    }

    const watermarkY = height - size.padding;
    const footerTextY = watermarkY - (text.watermark ? 24 : 0);

    if (text.footerText) {
        ctx.font = '500 16px Inter, system-ui, sans-serif';
        ctx.fillStyle = theme.textMuted;
        ctx.fillText(text.footerText, width / 2, footerTextY);
    }

    if (text.watermark) {
        ctx.font = '500 14px Inter, system-ui, sans-serif';
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = theme.textMuted;
        ctx.fillText(text.watermark, width / 2, watermarkY);
        ctx.globalAlpha = 1.0;
    }

    return canvas;
}

async function composeElegantPoster(args: ComposeArgs): Promise<HTMLCanvasElement> {
    const { parsed, qrCanvas, theme, size, text, logo } = args;
    const width = Math.max(720, size.width);
    const height = size.height > 0 ? size.height : width * 1.25;
    const canvas = document.createElement('canvas');
    canvas.width = width * size.scale;
    canvas.height = height * size.scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(size.scale, size.scale);

    const sidebarWidth = width * 0.35;
    const contentX = sidebarWidth + size.padding;

    /* --- Render Sidebar --- */
    ctx.fillStyle = theme.primary;
    ctx.fillRect(0, 0, sidebarWidth, height);
    drawTechShapes(ctx, sidebarWidth, height, { ...theme, techPatternColor: 'rgba(255,255,255,0.5)' });
    drawPattern(ctx, { ...theme, patternOpacity: 0.2 }, 0, 0, sidebarWidth, height);

    /* --- Render Area Utama --- */
    ctx.fillStyle = theme.pageBg;
    ctx.fillRect(sidebarWidth, 0, width - sidebarWidth, height);
    drawTechShapes(ctx, width - sidebarWidth, height, theme, sidebarWidth, 0);
    drawPattern(ctx, theme, sidebarWidth, 0, width - sidebarWidth, height);

    /* --- Gambar Konten --- */
    ctx.fillStyle = theme.cardBg;
    let currentY = size.padding * 2;
    ctx.textAlign = 'left';
    if (text.appName) {
        ctx.font = '800 24px Inter, system-ui, sans-serif';
        wrapText(ctx, text.appName.toUpperCase(), size.padding, currentY, sidebarWidth - size.padding * 2, 30);
        currentY += 80;
    }
    if (parsed.merchantName) {
        ctx.font = '700 22px Inter, system-ui, sans-serif';
        wrapText(ctx, parsed.merchantName, size.padding, currentY, sidebarWidth - size.padding * 2, 28);
    }
    if (text.watermark) {
        ctx.font = '500 12px Inter, system-ui, sans-serif';
        ctx.fillText(text.watermark, size.padding, height - size.padding);
    }

    const qrSizeVal = Math.min(width - contentX - size.padding, height - size.padding * 4);
    const qrX = contentX + (width - sidebarWidth - qrSizeVal) / 2 - size.padding / 2;
    const qrY = (height - qrSizeVal) / 2;
    ctx.drawImage(qrCanvas, qrX, qrY, qrSizeVal, qrSizeVal);
    if (logo) drawLogoOnQr(ctx, logo, qrX, qrY, qrSizeVal, theme.qrLight);

    ctx.textAlign = 'center';
    ctx.fillStyle = theme.text;
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    ctx.fillText(text.caption || 'Scan to pay', qrX + qrSizeVal / 2, qrY + qrSizeVal + 30);

    const inferredRef = text.invoiceReference || parsed.invoiceReference;
    if (inferredRef) {
        ctx.fillStyle = theme.textMuted;
        ctx.font = '600 16px Inter, system-ui, sans-serif';
        ctx.fillText(`#${inferredRef}`, qrX + qrSizeVal / 2, qrY + qrSizeVal + 55);
    }

    return canvas;
}

async function composeCorporatePoster(args: ComposeArgs): Promise<HTMLCanvasElement> {
    const { parsed, qrCanvas, theme, size, text, logo, qrisLogo } = args;
    const width = Math.max(720, size.width);
    const estHeight = width * 1.33;
    const height = size.height > 0 ? size.height : estHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width * size.scale;
    canvas.height = height * size.scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(size.scale, size.scale);

    const headerH = 100;
    const footerH = 60;

    /* --- Latar Belakang & Pola --- */
    ctx.fillStyle = theme.pageBg;
    ctx.fillRect(0, 0, width, height);
    drawTechShapes(ctx, width, height, theme);
    drawPattern(ctx, theme, 0, 0, width, height);

    /* --- Header & Footer --- */
    const headerGrad = ctx.createLinearGradient(0, 0, width, 0);
    headerGrad.addColorStop(0, theme.primary);
    headerGrad.addColorStop(1, theme.primaryDark);
    ctx.fillStyle = headerGrad;
    ctx.fillRect(0, 0, width, headerH);
    ctx.fillStyle = theme.cardBg;
    ctx.font = '800 32px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(text.appName.toUpperCase(), size.padding, headerH / 2 + 12);
    if (qrisLogo) {
        const logoH = 36;
        const logoW = (qrisLogo.width / qrisLogo.height) * logoH;
        ctx.drawImage(qrisLogo, width - size.padding - logoW, (headerH - logoH) / 2, logoW, logoH);
    }

    ctx.fillStyle = theme.primaryDark;
    ctx.fillRect(0, height - footerH, width, footerH);
    if (text.watermark) {
        ctx.fillStyle = theme.pageBg;
        ctx.globalAlpha = 0.7;
        ctx.font = '500 14px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(text.watermark, width / 2, height - footerH / 2 + 5);
        ctx.globalAlpha = 1;
    }

    /* --- Konten Utama --- */
    let currentY = headerH + size.padding * 1.5;
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.text;
    ctx.font = '700 26px Inter, system-ui, sans-serif';
    ctx.fillText(parsed.merchantName || 'Merchant', width / 2, currentY);
    currentY += 32;

    ctx.fillStyle = theme.textMuted;
    ctx.font = '500 16px Inter, system-ui, sans-serif';
    ctx.fillText([parsed.merchantId, parsed.merchantCity].filter(Boolean).join(' | '), width / 2, currentY);
    currentY += 40;

    const qrSizeVal = height - currentY - footerH - size.padding * 2;
    const qrX = (width - qrSizeVal) / 2;
    const qrY = currentY;
    ctx.fillStyle = theme.cardBg;
    ctx.fillRect(qrX - 4, qrY - 4, qrSizeVal + 8, qrSizeVal + 8);
    ctx.drawImage(qrCanvas, qrX, qrY, qrSizeVal, qrSizeVal);
    if (logo) drawLogoOnQr(ctx, logo, qrX, qrY, qrSizeVal, theme.qrLight);
    currentY += qrSizeVal + 24;

    ctx.fillStyle = theme.text;
    ctx.font = '600 18px Inter, system-ui, sans-serif';
    ctx.fillText(text.caption || 'Scan to pay', width / 2, currentY);

    return canvas;
}

async function composeDefaultPoster(args: ComposeArgs): Promise<HTMLCanvasElement> {
    const { parsed, qrCanvas, theme, size, text, logo } = args;
    const cardHCore = size.qrSize + size.quietZone * 2 + size.cardPadding * 2 + 120;
    const autoHeight = size.height > 0 ? size.height : size.headerHeight + size.padding + cardHCore + size.footerHeight + size.padding;
    const width = Math.max(720, size.width);
    const height = autoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width * size.scale;
    canvas.height = height * size.scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(size.scale, size.scale);

    /* --- Latar Belakang & Header --- */
    ctx.fillStyle = theme.pageBg;
    ctx.fillRect(0, 0, width, height);
    drawTechShapes(ctx, width, height, theme);
    const headerGrad = ctx.createLinearGradient(0, 0, width, 0);
    headerGrad.addColorStop(0, theme.primary);
    headerGrad.addColorStop(1, theme.primaryDark);
    ctx.fillStyle = headerGrad;
    ctx.fillRect(0, 0, width, size.headerHeight);
    if (theme.accentShapes) {
        drawAccentShapes(ctx, width, size.headerHeight, theme);
    }

    /* --- Teks Header --- */
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.font = '700 28px Inter, system-ui, sans-serif';
    ctx.fillText((text.appName || 'App').toUpperCase(), size.padding, 58);

    ctx.textAlign = 'right';
    ctx.font = '800 42px Inter, system-ui, sans-serif';
    ctx.fillText(ensureQrisInTitle(text.title), width - size.padding, 64);

    ctx.textAlign = 'left';
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    if (parsed.merchantName) ctx.fillText(parsed.merchantName, size.padding, 100);
    ctx.font = '500 16px Inter, system-ui, sans-serif';
    const m2 = [parsed.merchantId, parsed.merchantCity, parsed.amount ? formatAmount(parsed.amount, parsed.currency) : ''].filter(Boolean);
    if (m2.length) ctx.fillText(m2.join(' • '), size.padding, 128);

    /* --- Kartu QR --- */
    const cardW = size.qrSize + size.quietZone * 2 + size.cardPadding * 2;
    const cardH = cardHCore;
    const cardX = (width - cardW) / 2;
    const cardY = size.headerHeight + size.padding;

    drawRoundedRect(ctx, cardX, cardY, cardW, cardH, size.cardRadius);
    ctx.fillStyle = theme.cardBg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#E5E7EB';
    ctx.stroke();
    drawPattern(ctx, theme, cardX, cardY, cardW, cardH);

    const qx = cardX + size.cardPadding;
    const qy = cardY + size.cardPadding;
    const qSizeVal = size.qrSize + size.quietZone * 2;
    ctx.fillStyle = theme.qrLight;
    ctx.fillRect(qx, qy, qSizeVal, qSizeVal);

    const qrX = qx + size.quietZone;
    const qrY = qy + size.quietZone;
    ctx.drawImage(qrCanvas, qrX, qrY, size.qrSize, size.qrSize);
    if (logo) {
        drawLogoOnQr(ctx, logo, qrX, qrY, size.qrSize, theme.cardBg);
    }

    /* --- Teks & Watermark --- */
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.textMuted;
    ctx.font = '600 18px Inter, system-ui, sans-serif';
    ctx.fillText(text.caption || 'Scan to pay', cardX + cardW / 2, qy + qSizeVal + 48);

    ctx.fillStyle = theme.text;
    ctx.font = '700 18px Inter, system-ui, sans-serif';
    const footerY = cardY + cardH + 52;
    const inferredRef = text.invoiceReference || parsed.invoiceReference;
    const footerLine = inferredRef ? `#${inferredRef}` : parsed.validCrc ? 'QR verified' : '';
    ctx.fillText(footerLine, width / 2, footerY);

    if (text.watermark) {
        ctx.textAlign = 'right';
        ctx.fillStyle = theme.textMuted;
        ctx.font = '500 12px Inter, system-ui, sans-serif';
        ctx.fillText(text.watermark, width - size.padding, height - 12);
    }

    return canvas;
}

/* ------------------------------- Patterns & Shapes -------------------------------- */
function drawTechShapes(ctx: CanvasRenderingContext2D, width: number, height: number, theme: QrisPosterTheme, offsetX = 0, offsetY = 0) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = theme.techPatternColor || theme.primary;
    ctx.fillStyle = theme.techPatternColor || theme.primary;
    ctx.lineWidth = 0.8;

    const gridSize = 40;
    const nodes: { x: number; y: number }[] = [];

    for (let y = 0; y < height + gridSize; y += gridSize) {
        for (let x = 0; x < width + gridSize; x += gridSize) {
            nodes.push({
                x: offsetX + x + (Math.random() - 0.5) * gridSize * 0.4,
                y: offsetY + y + (Math.random() - 0.5) * gridSize * 0.4,
            });
        }
    }

    ctx.beginPath();
    nodes.forEach((p1, i) => {
        for (let j = i + 1; j < nodes.length; j++) {
            const p2 = nodes[j];
            const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);

            if (dist < gridSize * 1.8 && Math.random() > 0.6) {
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
            }
        }
    });
    ctx.stroke();

    ctx.beginPath();
    nodes.forEach((p) => {
        ctx.moveTo(p.x, p.y);
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    });
    ctx.fill();

    ctx.restore();
}

function drawModernAccentShapes(ctx: CanvasRenderingContext2D, width: number, height: number, theme: QrisPosterTheme) {
    ctx.save();
    const color1 = theme.accentShapeColor1 || theme.primary;
    const color2 = theme.accentShapeColor2 || theme.primaryDark;

    ctx.globalAlpha = 1;
    ctx.fillStyle = color1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(width * 0.1, height * 0.2, width * 0.3, height * 0.05, width * 0.4, 0);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = color2;
    ctx.beginPath();
    ctx.moveTo(width, height);
    ctx.bezierCurveTo(width * 0.9, height * 0.8, width * 0.7, height * 0.95, width * 0.6, height);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color1;
    ctx.beginPath();
    ctx.arc(width * 0.25, height * 0.4, width * 0.15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color2;
    ctx.beginPath();
    ctx.arc(width * 0.8, height * 0.2, width * 0.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color1;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.7);
    ctx.bezierCurveTo(width * 0.3, height * 0.6, width * 0.7, height * 0.9, width, height * 0.75);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
}

function drawPattern(ctx: CanvasRenderingContext2D, theme: QrisPosterTheme, x: number, y: number, w: number, h: number) {
    if (theme.pattern === 'none' || theme.patternOpacity <= 0) return;
    const alpha = Math.max(0, Math.min(1, theme.patternOpacity));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    const patterns: Record<QrPattern, () => void> = {
        dots: () => {
            ctx.fillStyle = '#CBD5E1';
            const step = 16;
            for (let py = y + 8; py < y + h; py += step)
                for (let px = x + 8; px < x + w; px += step) {
                    ctx.beginPath();
                    ctx.arc(px, py, 1.2, 0, Math.PI * 2);
                    ctx.fill();
                }
        },
        grid: () => {
            ctx.strokeStyle = '#E5E7EB';
            ctx.lineWidth = 1;
            const step = 20;
            for (let i = x; i <= x + w; i += step) {
                ctx.beginPath();
                ctx.moveTo(i + 0.5, y);
                ctx.lineTo(i + 0.5, y + h);
                ctx.stroke();
            }
            for (let i = y; i <= y + h; i += step) {
                ctx.beginPath();
                ctx.moveTo(x, i + 0.5);
                ctx.lineTo(x + w, i + 0.5);
                ctx.stroke();
            }
        },
        diagonal: () => {
            ctx.strokeStyle = '#E5E7EB';
            ctx.lineWidth = 1;
            const spacing = 18;
            for (let d = -h; d < w + h; d += spacing) {
                ctx.beginPath();
                ctx.moveTo(x + d, y);
                ctx.lineTo(x + d - h, y + h);
                ctx.stroke();
            }
        },
        waves: () => {
            ctx.strokeStyle = '#E2E8F0';
            ctx.lineWidth = 1.5;
            const amp = 4,
                wl = 30;
            for (let py = y + 10; py < y + h; py += 20) {
                ctx.beginPath();
                for (let px = x; px <= x + w; px += 1) {
                    const yy = py + Math.sin((px / wl) * Math.PI * 2) * amp;
                    if (px === x) ctx.moveTo(px, yy);
                    else ctx.lineTo(px, yy);
                }
                ctx.stroke();
            }
        },
        triangles: () => {
            ctx.fillStyle = '#E5E7EB';
            const side = 18,
                hgt = (side * Math.sqrt(3)) / 2;
            for (let row = 0; row * hgt < h + hgt; row++)
                for (let col = 0; col * side < w + side; col++) {
                    const cx = x + col * side - (row % 2 ? 0 : side / 2);
                    const cy = y + row * hgt;
                    ctx.beginPath();
                    ctx.moveTo(cx, cy);
                    ctx.lineTo(cx + side / 2, cy + hgt);
                    ctx.lineTo(cx - side / 2, cy + hgt);
                    ctx.closePath();
                    ctx.fill();
                }
        },
        scribble: () => {
            ctx.strokeStyle = '#D1D5DB';
            ctx.lineWidth = 0.75;
            for (let i = 0; i < (w * h) / 800; i++) {
                const sx = x + Math.random() * w,
                    sy = y + Math.random() * h;
                const ex = sx + (Math.random() - 0.5) * 40,
                    ey = sy + (Math.random() - 0.5) * 40;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.quadraticCurveTo(sx + (Math.random() - 0.5) * 20, sy + (Math.random() - 0.5) * 20, ex, ey);
                ctx.stroke();
            }
        },
        none: () => {},
    };

    if (patterns[theme.pattern]) patterns[theme.pattern]();

    ctx.restore();
}

function drawAccentShapes(ctx: CanvasRenderingContext2D, width: number, headerH: number, theme: QrisPosterTheme) {
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = theme.primary ?? '#FFFFFF';
    drawRoundedRect(ctx, width * 0.65, headerH * 0.2, width * 0.25, 22, 11);
    ctx.fill();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = theme.primaryDark ?? '#1a1a1a';
    drawRoundedRect(ctx, width * 0.48, headerH * 0.55, width * 0.18, 9, 9);
    ctx.fill();
    ctx.restore();
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

/* ------------------------------ Utilities -------------------------------- */
let scriptPromise: Promise<void> | null = null;
function loadScript(src: string): Promise<void> {
    if (scriptPromise) {
        return scriptPromise;
    }
    scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
    return scriptPromise;
}

function drawLogoOnQr(ctx: CanvasRenderingContext2D, logo: HTMLImageElement, qrX: number, qrY: number, qrSize: number, bgColor: string) {
    const maxLogo = Math.floor(qrSize * 0.18);
    const lw = Math.min(maxLogo, logo.width);
    const lh = Math.min(maxLogo, logo.height);
    const lx = qrX + (qrSize - lw) / 2;
    const ly = qrY + (qrSize - lh) / 2;
    const pad = Math.floor(lw * 0.25);
    drawRoundedRect(ctx, lx - pad / 2, ly - pad / 2, lw + pad, lh + pad, 6);
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.drawImage(logo, lx, ly, lw, lh);
}

function wrapText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
    const words = text.split(' ');
    let line = '';
    let currentY = y;
    for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = context.measureText(testLine);
        if (metrics.width > maxWidth && n > 0) {
            context.fillText(line, x, currentY);
            line = words[n] + ' ';
            currentY += lineHeight;
        } else {
            line = testLine;
        }
    }
    context.fillText(line, x, currentY);
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => {
            console.error(`Failed to load image: ${src}`);
            resolve(null);
        };
        img.src = src;
    });
}

function ensureQrisInTitle(title: string | undefined): string {
    const base = (title || 'QRIS').trim();
    return /\bQRIS\b/i.test(base) ? base : `${base} · QRIS`;
}

function mergeTheme(partial?: Partial<QrisPosterTheme>): QrisPosterTheme {
    return { ...DEFAULT_THEME, ...(partial || {}) };
}

function mergeSize(partial?: Partial<QrisPosterSize>): QrisPosterSize {
    return { ...DEFAULT_SIZE, ...(partial || {}) };
}

function mergeText(partial?: Partial<QrisPosterText>): QrisPosterText {
    return { ...DEFAULT_TEXT, ...(partial || {}) };
}

function suggestFileName(qrisString: string, overrideText?: Partial<QrisPosterText>): string {
    const parsed = parseQrisTLV(qrisString);
    const ref = overrideText?.invoiceReference || parsed.invoiceReference;
    const parts = [parsed.merchantName || 'QRIS', parsed.merchantId, ref].filter(Boolean);
    return sanitizeFileName(parts.join('_') || 'QRIS');
}

function sanitizeFileName(name?: string): string {
    return (
        (name || '')
            .trim()
            .replace(/[\s]+/g, '_')
            .replace(/[^a-zA-Z0-9_\-.]+/g, '')
            .slice(0, 100) || 'file'
    );
}

function strOrUndef(v: any): string | undefined {
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function formatAmount(amount?: string, currency?: string): string {
    if (!amount) return '';
    const n = Number(amount);
    if (!Number.isFinite(n)) return amount;
    if (currency === '360') {
        try {
            return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(
                n,
            );
        } catch {
            return `IDR ${n.toLocaleString('id-ID')}`;
        }
    }
    return `${currency || ''} ${n.toLocaleString('id-ID')}`;
}

/* ---------------------------- QRIS TLV Parsing & CRC Validation --------------------------- */
export function parseQrisTLV(src: string): ParsedQris {
    const safe = (src || '').trim();
    const tlv = parseEmvTlv(safe);
    const merchantName = strOrUndef(tlv['59']);
    const merchantCity = strOrUndef(tlv['60']);
    const currency = strOrUndef(tlv['53']);
    const amount = strOrUndef(tlv['54']);
    const merchantId = findNMID(tlv);
    const { invoiceReference } = extractAdditionalData(tlv);
    const validCrc = validateQrisCrc(safe);
    return { raw: safe, tlv, merchantName, merchantId, merchantCity, currency, amount, invoiceReference, validCrc };
}
function parseEmvTlv(s: string, start = 0, end?: number): Record<string, any> {
    const out: Record<string, any> = {};
    let i = start;
    const max = end ?? s.length;
    while (i + 4 <= max) {
        const tag = s.slice(i, i + 2);
        i += 2;
        const lenStr = s.slice(i, i + 2);
        i += 2;
        const len = parseInt(lenStr, 10);
        if (!Number.isFinite(len) || len < 0 || i + len > max) break;
        const val = s.slice(i, i + len);
        i += len;
        const tagNum = Number(tag);
        if ((tagNum >= 26 && tagNum <= 51) || tagNum === 62) out[tag] = parseEmvTlv(val, 0, val.length);
        else out[tag] = val;
        if (tag === '63') break;
    }
    return out;
}
function findNMID(obj: Record<string, any>): string | undefined {
    const stack: any[] = [obj];
    while (stack.length) {
        const cur = stack.pop();
        for (const k in cur) {
            const v = cur[k];
            if (k === '02' && typeof v === 'string' && v.trim()) return v.trim();
            if (v && typeof v === 'object') stack.push(v);
        }
    }
    return undefined;
}
function extractAdditionalData(obj: Record<string, any>): { invoiceReference?: string; billNumber?: string } {
    const tag62 = obj['62'];
    if (!tag62 || typeof tag62 !== 'object') return {};
    const billNumber = strOrUndef(tag62['01']);
    const reference = strOrUndef(tag62['05']);
    return { billNumber, invoiceReference: reference || billNumber };
}
function validateQrisCrc(str: string): boolean {
    const idx = str.indexOf('6304');
    if (idx < 0) return false;
    const data = str.slice(0, idx + 4);
    const crcGiven = str.slice(idx + 4, idx + 8).toUpperCase();
    if (crcGiven.length < 4) return false;
    const crcCalc = crc16IBM(asciiToBytes(data)).toString(16).toUpperCase().padStart(4, '0');
    return crcCalc === crcGiven;
}
function asciiToBytes(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}
function crc16IBM(bytes: Uint8Array): number {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let j = 0; j < 8; j++) {
            crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
        }
    }
    return crc & 0xffff;
}
