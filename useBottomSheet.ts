/* ----------------------------------------------------------------------------
| useBottomSheet.ts — Production-ready Bottom Sheet (Vue 3)
| - Swiftboard compatibility aliases (isDetailOpen, getClientY, closeSheetAnimated, etc.)
| - Strong scroll/drag arbitration, rubber-band UP (no negative translateY)
| - Focus trap, ESC/backdrop/history close
| - Dynamic onKeydown registry: keydown.on(handler, { priority, once }) -> off()
|---------------------------------------------------------------------------- */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';

/* -------------------------------- Types --------------------------------- */
export type AnyInputEvent = PointerEvent | MouseEvent | TouchEvent;
export type CloseReason = 'programmatic' | 'backdrop' | 'esc' | 'drag' | 'internal' | 'history';

export interface BottomSheetHooks {
    onBeforeClose?: (reason: CloseReason) => boolean | Promise<boolean>;
    onOpen?: () => void;
    onAfterOpen?: () => void;
    onClose?: (reason: CloseReason) => void;
    onDragStart?: () => void;
    onDrag?: (deltaY: number, progress: number) => void;
    onDragEnd?: (closed: boolean) => void;
    onSnap?: (index: number, progress: number) => void;
    /** Optional default keyboard hook (runs with priority 0). Prefer keydown.on() for dynamic control. */
    onKeydown?: (e: KeyboardEvent, api: KeydownAPI) => boolean | void;
}

type EventMap = {
    open: void;
    afterOpen: void;
    close: { reason: CloseReason };
    snap: { index: number; progress: number };
    dragStart: void;
    drag: { deltaY: number; progress: number };
    dragEnd: { closed: boolean };
};
type HandlerAny = (payload: unknown) => void;

function createEmitter() {
    const handlers = new Map<keyof EventMap, Set<HandlerAny>>();
    function on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void) {
        let set = handlers.get(event);
        if (!set) {
            set = new Set<HandlerAny>();
            handlers.set(event, set);
        }
        set.add(handler as HandlerAny);
        return () => set!.delete(handler as HandlerAny);
    }
    function off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void) {
        handlers.get(event)?.delete(handler as HandlerAny);
    }
    function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
        const set = handlers.get(event);
        if (!set) return;
        set.forEach((h) => {
            try {
                (h as (p: EventMap[K]) => void)(payload);
            } catch {
                /* no-op */
            }
        });
    }
    return { on, off, emit };
}

export interface BottomSheetOptions extends BottomSheetHooks {
    /** Behavior */
    breakpoint?: string; // default '(max-width: 640px)'
    mobileOnly?: boolean; // default true
    allowDesktopDrag?: boolean; // default false
    restrictDragToHandle?: boolean; // default false
    allowWheelSnap?: boolean; // default true
    wheelSnapCooldownMs?: number; // default 220
    rememberLastSnapIndex?: boolean; // default true

    /** Thresholds & motion */
    closeThresholdPx?: number; // default 120
    closeThresholdRatio?: number; // default 0.25
    flingVelocityPxPerMs?: number; // default 1.2
    animationMs?: number; // default 220
    fallbackExtraMs?: number; // default 120
    openAnimation?: 'fromBottom' | 'snap' | 'none'; // default 'fromBottom'
    openAnimationExtraPx?: number; // default 120

    /** Axis lock */
    axisLockThresholdPx?: number; // default 6
    axisLockAngleDeg?: number; // default 35

    /** Rubber band / over-drag */
    overdragUpPx?: number; // default 80
    overdragDownPx?: number; // default 120
    overdragDamping?: number; // default 0.5 (0..1)

    /** Double-tap to max open */
    enableDoubleTapToMax?: boolean; // default true
    doubleTapMaxDelayMs?: number; // default 250
    doubleTapMaxMovePx?: number; // default 14

    /** Focus/Scroll/History/Accessibility */
    lockBodySelection?: boolean; // default true
    lockBodyScroll?: boolean; // default true
    trapFocus?: boolean; // default true
    closeOnEsc?: boolean; // default true
    closeOnBackdrop?: boolean; // default true
    inertRoot?: string | HTMLElement | null; // default null
    autoCloseOnHistory?: boolean; // default true
    pushHistoryOnOpen?: boolean; // default true
    popHistoryOnClose?: boolean; // default true

    /** Snap system (0..1 relative to sheet height) */
    snapPoints?: number[]; // default [0, 1]
    initialSnapIndex?: number; // default 0

    /** Styling */
    autoInjectStyle?: boolean; // default true
    overlayMaxOpacity?: number; // default 0.4
    zIndexBase?: number; // default 1000
    baseStyles?: boolean; // default true

    /** Responsiveness */
    watchContentResize?: boolean; // default true

    /** Drag/scroll conflict tuning */
    autoFindScrollArea?: boolean; // default true (finds .bs-scroll inside sheet)
    dragIgnoreSelector?: string; // default 'input,textarea,select,button,[data-bs-skip-drag],[data-bs-no-drag],a[href]'
    allowDragFromScrollBottom?: boolean; // default true
}

/* ------------------------------- Utils ---------------------------------- */
function isTouchEvent(e: AnyInputEvent): e is TouchEvent {
    return 'touches' in e;
}
function clientYOf(e: AnyInputEvent): number {
    return isTouchEvent(e) ? (e.touches[0]?.clientY ?? 0) : ((e as PointerEvent | MouseEvent).clientY ?? 0);
}
function clientXOf(e: AnyInputEvent): number {
    return isTouchEvent(e) ? (e.touches[0]?.clientX ?? 0) : ((e as PointerEvent | MouseEvent).clientX ?? 0);
}
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    const sel = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'));
}
function clamp01(x: number) {
    return Math.min(1, Math.max(0, x));
}
function uniqSorted(arr: number[]) {
    return Array.from(new Set(arr.map(clamp01))).sort((a, b) => a - b);
}
function resolveEl(t?: string | HTMLElement | null): HTMLElement | null {
    return !t ? null : typeof t === 'string' ? (document.querySelector(t) as HTMLElement | null) : t;
}
function callIfFn<T extends unknown[]>(fn: ((...args: T) => void) | undefined, ...args: T): void {
    if (typeof fn === 'function') fn(...args);
}
function matchesSelector(el: HTMLElement | null, selector: string) {
    if (!el || !selector) return false;
    return el.matches(selector) || !!el.closest(selector);
}
function isScrollable(el: HTMLElement | null) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    if (!/(auto|scroll|overlay)/.test(oy)) return false;
    return el.scrollHeight > el.clientHeight + 1;
}
function findScrollableAncestor(start: HTMLElement | null, limit: HTMLElement | null) {
    let n: HTMLElement | null = start;
    while (n && n !== limit) {
        if (isScrollable(n)) return n;
        n = n.parentElement;
    }
    return null;
}

/* ------------------------------ Core CSS -------------------------------- */
const CORE_STYLE_ID = 'use-bottom-sheet-core-style';
const CORE_CSS = `
/* injected by useBottomSheet */
.no-select { user-select: none !important; -webkit-user-select: none !important; }

.bs-overlay {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0;
  background: #000; opacity: 0; pointer-events: auto;
}

.bs-sheet {
  position: fixed; left: 0; right: 0; bottom: 0;
  background: #fff; border-top-left-radius: 16px; border-top-right-radius: 16px;
  box-shadow: 0 10px 30px rgba(0,0,0,.2);
  max-height: min(88dvh, calc(100dvh - env(safe-area-inset-top, 0px)));
  touch-action: none; will-change: transform, opacity;
  outline: none;
  display: flex; flex-direction: column;
  transform-origin: bottom center;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

.bs-handle {
  width: 50px; height: 5px; border-radius: 999px; background: rgba(0,0,0,.15);
  margin: 8px auto 4px auto; cursor: grab;
}

.bs-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  min-height: 0;
}

.bs-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.bs-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,.15); border-radius: 8px; }
`;

function ensureCoreStyle(auto: boolean) {
    if (!auto) return;
    if (typeof document === 'undefined') return;
    if (document.getElementById(CORE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = CORE_STYLE_ID;
    style.textContent = CORE_CSS;
    document.head.appendChild(style);
}

/* --------------------------- Dynamic onKeydown --------------------------- */
export interface KeydownAPI {
    isOpen: Ref<boolean>;
    snapToIndex: (i: number, animate?: boolean) => void;
    snapTo: (p: number, animate?: boolean) => void;
    currentSnapIndex: ComputedRef<number>;
    snaps: ComputedRef<number[]>;
    close: (reason?: CloseReason) => void;
    requestClose: (reason: CloseReason) => void;
}
type KeydownHandler = (e: KeyboardEvent, api: KeydownAPI) => boolean | void;
type KeydownReg = { id: number; handler: KeydownHandler; priority: number; once: boolean; active: boolean };

function createKeydownRegistry(api: KeydownAPI) {
    const regs: KeydownReg[] = [];
    let seq = 0;
    function on(handler: KeydownHandler, opts?: { priority?: number; once?: boolean }) {
        const reg: KeydownReg = {
            id: ++seq,
            handler,
            priority: opts?.priority ?? 0,
            once: !!opts?.once,
            active: true,
        };
        regs.push(reg);
        regs.sort((a, b) => b.priority - a.priority);
        return () => {
            reg.active = false;
            const i = regs.indexOf(reg);
            if (i >= 0) regs.splice(i, 1);
        };
    }
    function run(e: KeyboardEvent): boolean {
        for (const reg of [...regs]) {
            if (!reg.active) continue;
            try {
                const handled = reg.handler(e, api);
                if (reg.once) {
                    reg.active = false;
                    const i = regs.indexOf(reg);
                    if (i >= 0) regs.splice(i, 1);
                }
                if (handled === true || e.defaultPrevented) return true;
            } catch {
                /* ignore bad handlers */
            }
        }
        return false;
    }
    function clear() {
        regs.splice(0, regs.length);
    }
    return { on, run, clear };
}

/* ----------------------------- Z-index stack ---------------------------- */
let STACK_COUNT = 0;

/* ------------------------------ Composable ------------------------------ */
export function useBottomSheet(opts: BottomSheetOptions = {}) {
    const {
        // Behavior
        breakpoint = '(max-width: 640px)',
        mobileOnly = true,
        allowDesktopDrag = false,
        restrictDragToHandle = false,
        allowWheelSnap = true,
        wheelSnapCooldownMs = 220,
        rememberLastSnapIndex = true,

        // Thresholds & motion
        closeThresholdPx = 120,
        closeThresholdRatio = 0.25,
        flingVelocityPxPerMs = 1.2,
        animationMs = 220,
        fallbackExtraMs = 120,
        openAnimation = 'fromBottom',
        openAnimationExtraPx = 120,

        // Axis lock
        axisLockThresholdPx = 6,
        axisLockAngleDeg = 35,

        // Rubber band
        overdragUpPx = 80,
        overdragDownPx = 120,
        overdragDamping = 0.5,

        // Double-tap
        enableDoubleTapToMax = true,
        doubleTapMaxDelayMs = 250,
        doubleTapMaxMovePx = 14,

        // Focus/Scroll/History
        lockBodySelection = true,
        lockBodyScroll = true,
        trapFocus = true,
        closeOnEsc = true,
        closeOnBackdrop = true,
        inertRoot = null,
        autoCloseOnHistory = true,
        pushHistoryOnOpen = true,
        popHistoryOnClose = true,

        // Snap
        snapPoints = [0, 1],
        initialSnapIndex = 0,

        // Styling
        autoInjectStyle = true,
        overlayMaxOpacity = 0.4,
        zIndexBase = 1000,
        baseStyles = true,

        // Responsiveness
        watchContentResize = true,

        // Drag/scroll
        autoFindScrollArea = true,
        dragIgnoreSelector = 'input,textarea,select,button,[contenteditable=""],[contenteditable="true"],[data-bs-skip-drag],[data-bs-no-drag],a[href]',
        allowDragFromScrollBottom = true,

        // Hooks
        onBeforeClose,
        onOpen,
        onAfterOpen,
        onClose,
        onDragStart,
        onDrag,
        onDragEnd,
        onSnap,
        onKeydown: onKeydownDefault,
    } = opts;

    /* ----- Events ----- */
    const events = createEmitter();

    /* ----- State ----- */
    const isOpen = ref(false);
    const isAnimating = ref(false);

    const sheetRef = ref<HTMLElement | null>(null);
    const handleRef = ref<HTMLElement | null>(null);
    const scrollAreaRef = ref<HTMLElement | null>(null);

    const isMobile = ref(false);
    let mq: MediaQueryList | null = null;
    let mqHandler: ((ev: MediaQueryListEvent) => void) | null = null;

    const supportsPointer = ref(false);
    const reduceMotion = ref(false);

    const translateY = ref(0);
    const dragging = ref(false);
    const activePointerId = ref<number | null>(null);

    let startY = 0;
    let startX = 0;
    let preDrag = false;
    let axisLocked: 'x' | 'y' | null = null;

    // velocity
    let lastY = 0,
        lastT = 0,
        vY = 0;

    // focus/scroll
    let lastFocused: HTMLElement | null = null;
    let savedScrollY = 0;

    // inert background
    let inertEl: HTMLElement | null = null;

    // stacking
    const stackIndex = ref<number | null>(null);

    // double-tap
    let lastTapTs = 0;
    let lastTapY = 0;

    // transition end
    let transitionHandler: ((this: Element, ev: TransitionEvent) => any) | null = null;

    // wheel snap throttle
    let lastWheelTs = 0;

    // ResizeObserver
    let ro: ResizeObserver | null = null;

    // Remember snap
    let lastSnapIndexMem = initialSnapIndex;

    // Rubber UP progress (0..1) for scale effect without negative translate
    const overUp = ref(0);

    const dragOrigin: {
        inScroll: boolean;
        scrollEl: HTMLElement | null;
        startScrollTop: number;
        startAtTop: boolean;
        startAtBottom: boolean;
    } = {
        inScroll: false,
        scrollEl: null,
        startScrollTop: 0,
        startAtTop: false,
        startAtBottom: false,
    };
    let scrollAreaPrevTouchAction: string | null = null;

    // Reactive snap points
    const snapPointsRef = ref<number[]>(snapPoints);
    const snaps = computed(() => uniqSorted(snapPointsRef.value.length ? snapPointsRef.value : [0, 1]));
    const currentSnapIndex = computed(() => {
        const h = sheetRef.value?.offsetHeight || 1;
        const p = clamp01(h ? translateY.value / h : 0);
        let idx = 0,
            dmin = Infinity;
        snaps.value.forEach((sp, i) => {
            const d = Math.abs(sp - p);
            if (d < dmin) {
                dmin = d;
                idx = i;
            }
        });
        return idx;
    });

    /* ----- Styles ----- */
    const dragProgress = computed(() => {
        const h = sheetRef.value?.offsetHeight || window.innerHeight || 1;
        return clamp01(translateY.value / h);
    });
    const sheetScale = computed(() => {
        // combine downward progress + upward elastic progress
        const p = Math.min(1, Math.max(0, dragProgress.value + overUp.value));
        return 1 - 0.02 * p; // shrink up to 2%
    });
    const overlayOpacity = computed(() => overlayMaxOpacity * (1 - dragProgress.value));
    const baseZ = computed(() => zIndexBase + (stackIndex.value ?? 0) * 2);

    const sheetStyle = computed<Record<string, string>>(() => {
        const s: Record<string, string> = {
            transform: `translateY(${Math.max(0, translateY.value)}px) scale(${sheetScale.value})`,
            transition: reduceMotion.value ? 'none' : `transform ${animationMs}ms ease, opacity ${animationMs}ms ease`,
            willChange: 'transform, opacity',
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
            zIndex: String(baseZ.value + 1),
        };
        if (baseStyles) {
            s.position = 'fixed';
            s.left = '0';
            s.right = '0';
            s.bottom = '0';
            s.background = '#fff';
            s.borderTopLeftRadius = '16px';
            s.borderTopRightRadius = '16px';
            s.boxShadow = '0 10px 30px rgba(0,0,0,.2)';
            s.maxHeight = 'min(88dvh, calc(100dvh - env(safe-area-inset-top, 0px)))';
            s.outline = 'none';
            s.display = 'flex';
            s.flexDirection = 'column';
            s.transformOrigin = 'bottom center';
            s.backfaceVisibility = 'hidden';
            s.WebkitBackfaceVisibility = 'hidden';
        }
        return s;
    });

    const overlayStyle = computed<Record<string, string>>(() => {
        const s: Record<string, string> = {
            opacity: String(overlayOpacity.value),
            transition: reduceMotion.value ? 'none' : `opacity ${animationMs}ms ease`,
            zIndex: String(baseZ.value),
        };
        if (baseStyles) {
            s.position = 'fixed';
            s.left = '0';
            s.right = '0';
            s.top = '0';
            s.bottom = '0';
            s.background = '#000';
        }
        return s;
    });

    const scrollAreaStyle = computed<Record<string, string>>(() => ({
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'pan-y',
        flex: '1 1 auto',
        minHeight: '0',
    }));

    function updateIsMobile() {
        if (typeof window === 'undefined') return;
        isMobile.value = window.matchMedia(breakpoint).matches;
    }

    /* ----- Scroll lock ----- */
    function lockScroll() {
        if (!lockBodyScroll) return;
        savedScrollY = window.scrollY || 0;
        const body = document.body;
        const sbw = window.innerWidth - document.documentElement.clientWidth;
        body.style.position = 'fixed';
        body.style.top = `-${savedScrollY}px`;
        body.style.left = '0';
        body.style.right = '0';
        body.style.width = '100%';
        if (sbw > 0) body.style.paddingRight = `${sbw}px`;
    }
    function unlockScroll() {
        if (!lockBodyScroll) return;
        const body = document.body;
        body.style.position = '';
        body.style.top = '';
        body.style.left = '';
        body.style.right = '';
        body.style.width = '';
        body.style.paddingRight = '';
        window.scrollTo(0, savedScrollY);
    }

    /* ----- inert background ----- */
    function setInert(on: boolean) {
        inertEl = resolveEl(inertRoot);
        if (!inertEl) return;
        try {
            if (on) {
                inertEl.setAttribute('inert', '');
                inertEl.setAttribute('aria-hidden', 'true');
            } else {
                inertEl.removeAttribute('inert');
                inertEl.removeAttribute('aria-hidden');
            }
        } catch {
            /* no-op */
        }
    }

    /* ----- Keydown Registry (dynamic) ----- */
    const keyApi: KeydownAPI = {
        isOpen,
        snapToIndex,
        snapTo,
        currentSnapIndex,
        snaps,
        close: (reason: CloseReason = 'programmatic') => close(reason),
        requestClose,
    };
    const keydown = createKeydownRegistry(keyApi);
    if (onKeydownDefault) keydown.on(onKeydownDefault, { priority: 0 });

    function focusTrapKeydown(e: KeyboardEvent) {
        if (!isOpen.value || !sheetRef.value) return;

        if (keydown.run(e)) return;

        if (trapFocus && e.key === 'Tab') {
            const nodes = focusablesIn(sheetRef.value);
            if (!nodes.length) return;
            const first = nodes[0],
                last = nodes[nodes.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey) {
                if (active === first || !nodes.includes(active as HTMLElement)) {
                    last.focus();
                    e.preventDefault();
                }
            } else {
                if (active === last) {
                    first.focus();
                    e.preventDefault();
                }
            }
            return;
        }

        if (closeOnEsc && e.key === 'Escape') {
            requestClose('esc');
            return;
        }
        if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
            e.preventDefault();
            const idx = currentSnapIndex.value;
            if (e.key === 'ArrowUp' || e.key === 'PageUp') snapToIndex(Math.max(0, idx - 1), true);
            if (e.key === 'ArrowDown' || e.key === 'PageDown') snapToIndex(Math.min(snaps.value.length - 1, idx + 1), true);
            if (e.key === 'Home') snapToIndex(0, true);
            if (e.key === 'End') snapToIndex(snaps.value.length - 1, true);
        }
    }

    /* ----- Open/close ----- */
    function performOpenAnimation() {
        if (!sheetRef.value) return;
        const h = sheetRef.value.offsetHeight || 0;
        const targetIndex = rememberLastSnapIndex ? lastSnapIndexMem : initialSnapIndex;

        if (openAnimation === 'fromBottom') {
            isAnimating.value = true;
            translateY.value = h + openAnimationExtraPx;
            requestAnimationFrame(() => snapToIndex(targetIndex, true));
        } else if (openAnimation === 'snap') {
            snapToIndex(targetIndex, true);
        } else {
            snapToIndex(targetIndex, false);
        }
    }

    function open() {
        isOpen.value = true;
        stackIndex.value = ++STACK_COUNT;
        if (pushHistoryOnOpen) {
            try {
                window.history.pushState({ __bs__: true }, '');
            } catch {}
        }
        requestAnimationFrame(() => performOpenAnimation());
    }

    async function requestClose(reason: CloseReason) {
        if (onBeforeClose) {
            try {
                const ok = await onBeforeClose(reason);
                if (!ok) return;
            } catch {
                return;
            }
        }
        close(reason);
    }

    function close(reason: CloseReason = 'programmatic') {
        isOpen.value = false;
        translateY.value = 0;
        overUp.value = 0;
        if (lockBodySelection) document.body.classList.remove('no-select');
        activePointerId.value = null;
        preDrag = false;
        axisLocked = null;
        setInert(false);
        if (stackIndex.value !== null) {
            STACK_COUNT = Math.max(0, STACK_COUNT - 1);
            stackIndex.value = null;
        }
        if (popHistoryOnClose && reason !== 'history') {
            try {
                if (window.history.state && (window.history.state as any).__bs__) window.history.back();
            } catch {}
        }
        try {
            callIfFn(onClose, reason);
        } catch {}
        events.emit('close', { reason });
    }

    function closeAnimated(reason: CloseReason = 'programmatic') {
        if (!isOpen.value) return;
        const h = (sheetRef.value?.offsetHeight || 0) + openAnimationExtraPx;
        isAnimating.value = true;
        requestAnimationFrame(() => {
            translateY.value = h;
            let done = false;
            const onDone = () => {
                if (done) return;
                done = true;
                if (sheetRef.value) sheetRef.value.removeEventListener('transitionend', onDone);
                isAnimating.value = false;
                close(reason);
            };
            sheetRef.value?.addEventListener('transitionend', onDone, { once: true });
            // use fallbackExtraMs option
            const tid = window.setTimeout(onDone, animationMs + fallbackExtraMs);
            const clear = () => {
                window.clearTimeout(tid);
                sheetRef.value?.removeEventListener('transitionend', clear);
            };
            sheetRef.value?.addEventListener('transitionend', clear, { once: true });
        });
    }

    /* ----- Snap API ----- */
    function snapTo(progress: number, animate = true) {
        const h = sheetRef.value?.offsetHeight || 0;
        const targetPx = clamp01(progress) * h;
        if (!animate || reduceMotion.value) {
            translateY.value = targetPx;
            return;
        }
        isAnimating.value = true;
        translateY.value = targetPx;
    }
    function snapToIndex(index: number, animate = true) {
        const pts = snaps.value;
        const i = Math.max(0, Math.min(pts.length - 1, index | 0));
        const p = pts[i];
        snapTo(p, animate);
        lastSnapIndexMem = i;
        try {
            callIfFn(onSnap, i, p);
        } catch {}
        events.emit('snap', { index: i, progress: p });
    }

    /* ----- Drag helpers + rubber band ----- */
    function canStartDragFromTarget(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        if (!el) return false;
        if (matchesSelector(el, dragIgnoreSelector)) return false;
        if (restrictDragToHandle) return !!(handleRef.value && (el === handleRef.value || handleRef.value.contains(el)));
        return true;
    }

    function setScrollAreaDragLock(on: boolean) {
        const node = dragOrigin.scrollEl;
        if (!node) return;
        try {
            if (on) {
                scrollAreaPrevTouchAction = node.style.touchAction;
                node.style.touchAction = 'none';
            } else {
                node.style.touchAction = scrollAreaPrevTouchAction ?? '';
                scrollAreaPrevTouchAction = null;
            }
        } catch {
            /* no-op */
        }
    }

    function startDrag(y: number) {
        dragging.value = true;
        lastY = y;
        lastT = performance.now();
        vY = 0;
        if (lockBodySelection) document.body.classList.add('no-select');
        if (activePointerId.value != null) {
            try {
                sheetRef.value?.setPointerCapture?.(activePointerId.value);
            } catch {}
        }
        try {
            callIfFn(onDragStart);
        } catch {}
        events.emit('dragStart', undefined);
        if (dragOrigin.inScroll) setScrollAreaDragLock(true);
    }

    function moveDrag(y: number) {
        if (!dragging.value) return;
        const now = performance.now();
        let dy = y - startY;

        const h = sheetRef.value?.offsetHeight || 0;

        if (dy < 0) {
            // (Never lift from bottom) keep translateY >= 0 and simulate with scale via overUp
            const t = clamp01(Math.abs(dy) / overdragUpPx);
            const eased = t * (1 - (1 - overdragDamping) * t);
            overUp.value = eased;
            dy = 0;
        } else {
            overUp.value = 0;
            // over-drag DOWN past height
            if (h > 0 && dy > h) {
                const beyond = dy - h;
                const capped = Math.min(overdragDownPx, beyond);
                const t = clamp01(capped / overdragDownPx);
                dy = h + capped * (1 - (1 - overdragDamping) * t);
            }
        }

        translateY.value = Math.max(0, dy);

        if (lastT) vY = (y - lastY) / (now - lastT); // px/ms
        lastY = y;
        lastT = now;

        try {
            callIfFn(onDrag, translateY.value, dragProgress.value);
        } catch {}
        events.emit('drag', { deltaY: translateY.value, progress: dragProgress.value });
    }

    function endDrag() {
        if (!dragging.value) return;
        dragging.value = false;

        // reset over-up elastic smoothly
        overUp.value = 0;

        const h = sheetRef.value?.offsetHeight || 0;
        const p = h ? translateY.value / h : 0;

        if (Math.abs(vY) > flingVelocityPxPerMs && vY > 0) {
            closeAnimated('drag');
        } else {
            const thresholdPx = Math.max(closeThresholdPx, h * closeThresholdRatio);
            if (translateY.value > thresholdPx) {
                closeAnimated('drag');
                try {
                    callIfFn(onDragEnd, true);
                } catch {}
                events.emit('dragEnd', { closed: true });
                cleanupGesture();
                return;
            }
            const points = snaps.value;
            let nearest = points[0],
                dmin = Infinity,
                ni = 0;
            for (let i = 0; i < points.length; i++) {
                const d = Math.abs(p - points[i]);
                if (d < dmin) {
                    dmin = d;
                    nearest = points[i];
                    ni = i;
                }
            }
            if (nearest >= 0.999) {
                closeAnimated('drag');
                try {
                    callIfFn(onDragEnd, true);
                } catch {}
                events.emit('dragEnd', { closed: true });
                cleanupGesture();
                return;
            }
            isAnimating.value = true;
            snapTo(nearest, true);
            if (lockBodySelection) document.body.classList.remove('no-select');
            try {
                callIfFn(onDragEnd, false);
                callIfFn(onSnap, ni, nearest);
            } catch {}
            events.emit('dragEnd', { closed: false });
            events.emit('snap', { index: ni, progress: nearest });
        }

        cleanupGesture();
    }

    function cleanupGesture() {
        lastY = 0;
        lastT = 0;
        vY = 0;
        overUp.value = 0;
        if (activePointerId.value != null) {
            try {
                sheetRef.value?.releasePointerCapture?.(activePointerId.value);
            } catch {}
        }
        activePointerId.value = null;
        preDrag = false;
        axisLocked = null;
        setScrollAreaDragLock(false);
        dragOrigin.inScroll = false;
        dragOrigin.scrollEl = null;
    }

    /* ----- Axis-lock + scroll/drag arbitration ----- */
    function evaluateAxisLock(currX: number, currY: number) {
        if (!preDrag || axisLocked) return;
        const dx = Math.abs(currX - startX);
        const dy = Math.abs(currY - startY);
        if (dx < axisLockThresholdPx && dy < axisLockThresholdPx) return;

        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        if (angle >= 90 - axisLockAngleDeg) {
            axisLocked = 'y';

            if (dragOrigin.inScroll && dragOrigin.scrollEl) {
                const el = dragOrigin.scrollEl;
                const pullingDown = currY - startY > 0;
                const pushingUp = currY - startY < 0;

                const atTopNow = el.scrollTop <= 0;
                const atBottomNow = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;

                if (
                    (pullingDown && (dragOrigin.startAtTop || atTopNow)) ||
                    (allowDragFromScrollBottom && pushingUp && (dragOrigin.startAtBottom || atBottomNow))
                ) {
                    startDrag(currY);
                    preDrag = false;
                } else {
                    preDrag = false;
                }
            } else {
                startDrag(currY);
                preDrag = false;
            }
        } else {
            axisLocked = 'x';
            preDrag = false; // horizontal ignore
        }
    }

    /* ----- Double-tap ----- */
    function maybeHandleDoubleTap(y: number) {
        if (!enableDoubleTapToMax) return;
        const now = performance.now();
        if (now - lastTapTs < doubleTapMaxDelayMs && Math.abs(y - lastTapY) < doubleTapMaxMovePx) {
            snapToIndex(0, true);
        }
        lastTapTs = now;
        lastTapY = y;
    }

    /* ----- Wheel snap ----- */
    function onWheel(e: WheelEvent) {
        if (!allowWheelSnap || !isOpen.value) return;
        const s = scrollAreaRef.value;
        if (s) {
            const atTop = s.scrollTop <= 0;
            const atBottom = Math.ceil(s.scrollTop + s.clientHeight) >= s.scrollHeight;
            if (!(atTop && e.deltaY < 0) && !(atBottom && e.deltaY > 0)) return;
        }
        const now = performance.now();
        if (now - lastWheelTs < wheelSnapCooldownMs) return;
        lastWheelTs = now;

        const idx = currentSnapIndex.value;
        if (e.deltaY > 0) {
            const next = Math.min(idx + 1, snaps.value.length - 1);
            snapToIndex(next, true);
            if (snaps.value[next] >= 0.999) closeAnimated('drag');
        } else if (e.deltaY < 0) {
            snapToIndex(Math.max(idx - 1, 0), true);
        }
    }

    /* ----- Input handlers ----- */
    function primeDragContextFromTarget(target: EventTarget | null) {
        const el = target as HTMLElement | null;
        dragOrigin.inScroll = false;
        dragOrigin.scrollEl = null;
        dragOrigin.startScrollTop = 0;
        dragOrigin.startAtTop = false;
        dragOrigin.startAtBottom = false;

        if (!el) return;

        let scrollEl: HTMLElement | null = scrollAreaRef.value;
        if (!scrollEl && autoFindScrollArea && sheetRef.value) {
            scrollEl = sheetRef.value.querySelector('.bs-scroll') as HTMLElement | null;
            if (scrollEl) scrollAreaRef.value = scrollEl;
        }
        if (!scrollEl) scrollEl = findScrollableAncestor(el, sheetRef.value);

        if (scrollEl && isScrollable(scrollEl)) {
            dragOrigin.inScroll = true;
            dragOrigin.scrollEl = scrollEl;
            dragOrigin.startScrollTop = scrollEl.scrollTop;
            dragOrigin.startAtTop = scrollEl.scrollTop <= 0;
            dragOrigin.startAtBottom = Math.ceil(scrollEl.scrollTop + scrollEl.clientHeight) >= scrollEl.scrollHeight;
        }
    }

    function onPointerDown(e: PointerEvent) {
        if (!isOpen.value) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (mobileOnly && !isMobile.value && !allowDesktopDrag) return;
        if (!canStartDragFromTarget(e.target)) return;

        activePointerId.value = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        preDrag = true;
        axisLocked = null;

        primeDragContextFromTarget(e.target);
        maybeHandleDoubleTap(e.clientY);
    }
    function onPointerMove(e: PointerEvent) {
        if (preDrag) evaluateAxisLock(e.clientX, e.clientY);
        if (dragging.value && activePointerId.value === e.pointerId) moveDrag(e.clientY);
    }
    function onPointerUp(e: PointerEvent) {
        if (activePointerId.value === e.pointerId) endDrag();
    }

    function onTouchStart(e: TouchEvent) {
        if (!isOpen.value || supportsPointer.value) return;
        if (mobileOnly && !isMobile.value && !allowDesktopDrag) return;
        if (!canStartDragFromTarget(e.target)) return;

        const cx = clientXOf(e),
            cy = clientYOf(e);
        startX = cx;
        startY = cy;
        preDrag = true;
        axisLocked = null;
        primeDragContextFromTarget(e.target);
        maybeHandleDoubleTap(cy);
    }
    function onTouchMove(e: TouchEvent) {
        if (supportsPointer.value) return;
        const cx = clientXOf(e),
            cy = clientYOf(e);
        if (preDrag) evaluateAxisLock(cx, cy);
        if (dragging.value) moveDrag(cy);
    }
    function onTouchEnd() {
        if (!supportsPointer.value) endDrag();
    }

    function onMouseDown(e: MouseEvent) {
        if (!isOpen.value) return;
        if (e.button !== 0) return;
        if (mobileOnly && !isMobile.value && !allowDesktopDrag) return;
        if (!canStartDragFromTarget(e.target)) return;

        startX = e.clientX;
        startY = e.clientY;
        preDrag = true;
        axisLocked = null;
        primeDragContextFromTarget(e.target);
        maybeHandleDoubleTap(e.clientY);
        window.addEventListener('mousemove', onMouseMove, { passive: false });
        window.addEventListener('mouseup', onMouseUp, { passive: true, once: true });
    }
    function onMouseMove(e: MouseEvent) {
        if (preDrag) evaluateAxisLock(e.clientX, e.clientY);
        if (dragging.value) moveDrag(e.clientY);
    }
    function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove);
        endDrag();
    }

    /* ----- Overlay click ----- */
    function onOverlayClick() {
        if (closeOnBackdrop) requestClose('backdrop');
    }

    /* ----- History (auto close) ----- */
    function onHistory() {
        if (isOpen.value) requestClose('history');
    }

    /* ----- Resize / orientation change ----- */
    function onWindowResize() {
        updateIsMobile();
        if (!isOpen.value || !sheetRef.value) return;
        const h = sheetRef.value.offsetHeight || 1;
        const p = clamp01(dragProgress.value);
        translateY.value = p * h;
    }

    /* ----- Lifecycle ----- */
    onMounted(() => {
        ensureCoreStyle(autoInjectStyle);

        supportsPointer.value = typeof window !== 'undefined' && 'PointerEvent' in window;
        reduceMotion.value = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        updateIsMobile();

        mq = window.matchMedia(breakpoint);
        mqHandler = (ev) => (isMobile.value = ev.matches);
        if ('addEventListener' in mq) mq.addEventListener('change', mqHandler);
        else (mq as any).addListener(mqHandler);

        document.addEventListener('keydown', focusTrapKeydown, { passive: false });

        if (autoCloseOnHistory) {
            window.addEventListener('popstate', onHistory);
            window.addEventListener('hashchange', onHistory);
        }
        window.addEventListener('resize', onWindowResize, { passive: true });
        window.addEventListener('orientationchange', onWindowResize, { passive: true });

        const el = sheetRef.value;
        if (el) {
            transitionHandler = () => {
                isAnimating.value = false;
            };
            el.addEventListener('transitionend', transitionHandler);
        }

        if (watchContentResize && 'ResizeObserver' in window) {
            ro = new ResizeObserver(() => {
                const node = sheetRef.value;
                if (!node) return;
                const h = node.offsetHeight || 1;
                const p = clamp01(dragProgress.value);
                translateY.value = p * h;
            });
            if (sheetRef.value) ro?.observe(sheetRef.value);
        }
    });

    onBeforeUnmount(() => {
        if (mq && mqHandler) {
            if ('removeEventListener' in mq) mq.removeEventListener('change', mqHandler);
            else (mq as any).removeListener(mqHandler);
        }
        if (lockBodySelection) document.body.classList.remove('no-select');
        window.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('keydown', focusTrapKeydown);
        if (autoCloseOnHistory) {
            window.removeEventListener('popstate', onHistory);
            window.removeEventListener('hashchange', onHistory);
        }
        window.removeEventListener('resize', onWindowResize);
        window.removeEventListener('orientationchange', onWindowResize);

        if (transitionHandler && sheetRef.value) {
            sheetRef.value.removeEventListener('transitionend', transitionHandler);
            transitionHandler = null;
        }
        if (ro) {
            try {
                ro.disconnect();
            } catch {}
            ro = null;
        }
        unlockScroll();
        setInert(false);
        keydown.clear();
    });

    /* ----- Open/Close watch ----- */
    watch(isOpen, async (open) => {
        if (open) {
            if (lockBodyScroll) lockScroll();
            // save focus before inert
            lastFocused = document.activeElement as HTMLElement | null;

            await nextTick();
            (sheetRef.value ?? undefined)?.setAttribute?.('tabindex', (sheetRef.value?.getAttribute('tabindex') ?? '-1') as string);
            sheetRef.value?.focus({ preventScroll: true });

            if (!scrollAreaRef.value && autoFindScrollArea && sheetRef.value) {
                const candidate = sheetRef.value.querySelector('.bs-scroll') as HTMLElement | null;
                if (candidate) scrollAreaRef.value = candidate;
            }

            requestAnimationFrame(() => {
                setInert(true);
                try {
                    callIfFn(onOpen);
                } catch {}
                try {
                    callIfFn(onAfterOpen);
                } catch {}
                events.emit('open', undefined);
                events.emit('afterOpen', undefined);
            });
        } else {
            setInert(false);
            unlockScroll();
            if (lastFocused) {
                try {
                    lastFocused.focus({ preventScroll: true });
                } catch {}
                lastFocused = null;
            }
        }
    });

    /* ----- Bind helpers (optional) ----- */
    const bindOverlay = (): Record<string, unknown> => ({
        class: 'bs-overlay',
        style: overlayStyle.value,
        onClick: onOverlayClick,
    });

    const bindSheet = (): Record<string, unknown> => ({
        ref: sheetRef,
        class: 'bs-sheet',
        style: sheetStyle.value,
        role: 'dialog' as const,
        'aria-modal': 'true',
        'data-open': String(isOpen.value),
        tabIndex: -1,

        onPointerdown: onPointerDown,
        onPointermove: onPointerMove,
        onPointerup: onPointerUp,
        onPointercancel: onPointerUp,
        onLostpointercapture: () => endDrag(),

        onTouchstartPassive: onTouchStart,
        onTouchmovePassive: onTouchMove,
        onTouchend: onTouchEnd,

        onMousedown: onMouseDown,

        onWheelPassive: onWheel,
    });

    const bindHandle = (): Record<string, unknown> => ({
        ref: handleRef,
        class: 'bs-handle',
        onPointerdown: onPointerDown,
        onPointermove: onPointerMove,
        onPointerup: onPointerUp,
        onPointercancel: onPointerUp,
        onLostpointercapture: () => endDrag(),
        onTouchstartPassive: onTouchStart,
        onTouchmovePassive: onTouchMove,
        onTouchend: onTouchEnd,
        onMousedown: onMouseDown,
    });

    const bindScrollArea = (): Record<string, unknown> => ({
        ref: scrollAreaRef,
        class: 'bs-scroll',
        style: scrollAreaStyle.value,
    });

    /* ----- Runtime utilities ----- */
    function toggle(force?: boolean) {
        const next = typeof force === 'boolean' ? force : !isOpen.value;
        if (next) open();
        else void requestClose('programmatic');
    }
    function setSnapPoints(points: number[], toIndex?: number) {
        if (!points || !points.length) return;
        const uniq = uniqSorted(points);
        snapPointsRef.value = uniq;
        if (typeof toIndex === 'number') {
            const i = Math.max(0, Math.min(uniq.length - 1, toIndex));
            snapTo(uniq[i], true);
            lastSnapIndexMem = i;
        }
    }
    function setBreakpoint(bp: string) {
        if (typeof window === 'undefined') return;
        try {
            if (mq && mqHandler) {
                if ('removeEventListener' in mq) mq.removeEventListener('change', mqHandler);
                else (mq as any).removeListener(mqHandler);
            }
            mq = window.matchMedia(bp);
            mqHandler = (ev) => (isMobile.value = ev.matches);
            if ('addEventListener' in mq) mq.addEventListener('change', mqHandler);
            else (mq as any).addListener(mqHandler);
            isMobile.value = mq.matches;
        } catch {
            /* no-op */
        }
    }

    /* ----- Swiftboard compatibility aliases ----- */
    const isDetailOpen = computed<boolean>({
        get: () => isOpen.value,
        set: (v) => (v ? open() : requestClose('programmatic')),
    });
    function getClientY(e: AnyInputEvent) {
        return clientYOf(e);
    }
    function closeSheetAnimated() {
        closeAnimated('programmatic');
    }

    /* ----- Expose ----- */
    return {
        /** state */
        isOpen,
        isAnimating,
        isMobile,
        sheetRef,
        handleRef,
        scrollAreaRef,
        translateY,
        dragging,
        dragProgress,
        sheetScale,
        overlayOpacity,
        sheetStyle,
        overlayStyle,
        snaps,
        currentSnapIndex,

        /** actions */
        open,
        toggle,
        close: () => requestClose('programmatic'),
        closeNow: close,
        closeAnimated: () => closeAnimated('programmatic'),
        requestClose,

        /** snap api */
        snapTo,
        snapToIndex,

        /** handlers */
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onTouchStart,
        onTouchMove,
        onTouchEnd,
        onMouseDown,
        onMouseMove,
        onMouseUp,
        onOverlayClick,

        bindOverlay,
        bindSheet,
        bindHandle,
        bindScrollArea,

        /** runtime utilities */
        setSnapPoints,
        setBreakpoint,
        updateIsMobile,

        /** events */
        events,

        /** keydown dynamic registry */
        keydown, // keydown.on(handler, { priority, once }) -> off()

        /** Swiftboard-style aliases (exact naming) */
        isDetailOpen,
        getClientY,
        closeSheetAnimated,
        activePointerId,
    };
}

/* ----------------------------------------------------------------------------
| Optional compatibility wrapper — Swiftboard-style API untuk konsumen lama
|---------------------------------------------------------------------------- */
export function useBottomSheetSwiftboardCompat(opts: BottomSheetOptions = {}) {
    const bs = useBottomSheet({
        breakpoint: '(max-width: 640px)',
        mobileOnly: true,
        allowDesktopDrag: false,
        restrictDragToHandle: false,
        animationMs: 220,
        fallbackExtraMs: 120,
        overlayMaxOpacity: 0.4,
        openAnimation: 'fromBottom',
        snapPoints: [0, 1],
        initialSnapIndex: 0,
        ...opts,
    });

    function onKeydown(e: KeyboardEvent) {
        // default: ESC to close
        if (e.key === 'Escape' && bs.isOpen.value) {
            bs.requestClose('esc');
        }
    }

    // keep "reset position when open" feel
    watch(bs.isDetailOpen, (open) => {
        if (open) bs.translateY.value = 0;
    });

    return {
        // state (names must match consumer)
        isDetailOpen: bs.isDetailOpen,
        isMobile: bs.isMobile,
        sheetRef: bs.sheetRef,
        scrollAreaRef: bs.scrollAreaRef,
        translateY: bs.translateY,
        dragging: bs.dragging,

        // computed visuals
        dragProgress: bs.dragProgress,
        sheetScale: bs.sheetScale,
        overlayOpacity: bs.overlayOpacity,
        sheetStyle: bs.sheetStyle,

        // actions
        closeSheetAnimated: bs.closeSheetAnimated,
        onKeydown,

        // pointer/touch/mouse
        onPointerDown: bs.onPointerDown,
        onPointerMove: bs.onPointerMove,
        onPointerUp: bs.onPointerUp,

        onTouchStart: bs.onTouchStart,
        onTouchMove: bs.onTouchMove,
        onTouchEnd: bs.onTouchEnd,

        onMouseDown: bs.onMouseDown,
        onMouseMove: bs.onMouseMove,
        onMouseUp: bs.onMouseUp,

        // helpers
        getClientY: bs.getClientY,
        updateIsMobile: bs.updateIsMobile,

        // dynamic keydown registry
        keydown: bs.keydown,

        // full power if needed
        open: bs.open,
        requestClose: bs.requestClose,
    };
}
