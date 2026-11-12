/**
 * BrightnessDragController
 *
 * Adds Apple Home style "slide across the tile to dim" to an element.
 *
 * Gesture rules:
 * - Pointer down records a candidate gesture; nothing happens yet, so taps and
 *   clicks behave exactly as before.
 * - Once the pointer travels more than DECIDE_PX, the dominant axis decides:
 *     horizontal -> brightness drag (pointer is captured, page does not scroll)
 *     vertical   -> gesture abandoned; the browser scrolls the page. The host
 *                   element must have `touch-action: pan-y` so touch browsers
 *                   keep vertical panning native and fire `pointercancel`.
 * - The drag is relative (like Apple Home): moving the full tile width changes
 *   brightness by 100 percentage points from wherever it started.
 * - Service calls are throttled while dragging (leading + trailing), and the
 *   final value is always sent on release.
 * - The click that browsers fire after a drag is swallowed in the capture
 *   phase, so a drag never also toggles the light or opens more-info.
 *
 * Works for mouse, touch and pen via Pointer Events.
 */
export interface BrightnessDragHost {
  /** Whether a drag may start right now (dimmable light, not in edit mode, available). */
  canDrag(): boolean;
  /** Current brightness in percent (0 when off). */
  getCurrentPct(): number;
  /** Right-to-left layout: dragging left increases brightness. */
  isRTL(): boolean;
  /** Called on every percentage change while dragging, for optimistic UI. */
  onPreview(pct: number): void;
  /** Called (throttled) with the brightness to send to Home Assistant. */
  onCommit(pct: number): void;
  /** Called once when a drag ends (released or cancelled). */
  onDragEnd(finalPct: number): void;
}

type GestureMode = 'pending' | 'dragging';

interface GestureState {
  pointerId: number;
  startX: number;
  startY: number;
  startPct: number;
  width: number;
  mode: GestureMode;
  pct: number;
}

export class BrightnessDragController {
  /** Movement (px) before deciding between drag and scroll/tap. */
  static DECIDE_PX = 8;
  /** Horizontal movement must beat vertical by this factor to count as a drag. */
  static AXIS_RATIO = 1.2;
  /** Minimum interval between service calls while dragging. */
  static THROTTLE_MS = 250;
  /** How long after a drag to swallow the synthetic click. */
  static CLICK_SUPPRESS_MS = 400;

  private gesture?: GestureState;
  private lastSentPct?: number;
  private lastSentAt = 0;
  private pendingPct?: number;
  private throttleTimer?: number;
  private suppressClickUntil = 0;

  private readonly onDown = (e: PointerEvent) => this.handleDown(e);
  private readonly onMove = (e: PointerEvent) => this.handleMove(e);
  private readonly onUp = (e: PointerEvent) => this.handleUp(e, false);
  private readonly onCancel = (e: PointerEvent) => this.handleUp(e, true);
  private readonly onClickCapture = (e: Event) => this.handleClickCapture(e);

  constructor(private readonly el: HTMLElement, private readonly host: BrightnessDragHost) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('click', this.onClickCapture, true);
  }

  get isDragging(): boolean {
    return this.gesture?.mode === 'dragging';
  }

  /** Remove listeners. Flushes a pending value so the last drag position is not lost. */
  destroy(): void {
    if (this.isDragging) {
      this.flush();
    }
    this.clearThrottle();
    this.gesture = undefined;
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
    this.el.removeEventListener('click', this.onClickCapture, true);
  }

  private handleDown(e: PointerEvent): void {
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!this.host.canDrag()) return;

    const width = this.el.getBoundingClientRect().width;
    if (width <= 0) return;

    const startPct = this.host.getCurrentPct();
    this.gesture = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startPct,
      width,
      mode: 'pending',
      pct: startPct,
    };
  }

  private handleMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (g.mode === 'pending') {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx < BrightnessDragController.DECIDE_PX && ady < BrightnessDragController.DECIDE_PX) {
        return; // still a potential tap
      }
      if (adx > ady * BrightnessDragController.AXIS_RATIO) {
        // Horizontal: take over. Discount the dead zone so the level doesn't jump,
        // but keep any movement beyond it (fast flicks can arrive as one big move).
        g.mode = 'dragging';
        g.startX += Math.sign(dx) * BrightnessDragController.DECIDE_PX;
        this.lastSentPct = g.startPct;
        this.lastSentAt = 0;
        try {
          this.el.setPointerCapture(e.pointerId);
        } catch {
          /* pointer may already be gone */
        }
        this.host.onPreview(g.pct);
      } else {
        // Vertical: let the page scroll (touch) or simply ignore (mouse).
        this.gesture = undefined;
        return;
      }
    }

    // Dragging
    e.preventDefault();
    const direction = this.host.isRTL() ? -1 : 1;
    const delta = ((e.clientX - g.startX) / g.width) * 100 * direction;
    const pct = Math.max(0, Math.min(100, Math.round(g.startPct + delta)));
    if (pct !== g.pct) {
      g.pct = pct;
      this.host.onPreview(pct);
      this.queue(pct);
    }
  }

  private handleUp(e: PointerEvent, cancelled: boolean): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = undefined;

    if (g.mode !== 'dragging') {
      return; // a tap (pointerup) or a scroll (pointercancel) - leave it to the browser
    }

    if (this.el.hasPointerCapture?.(e.pointerId)) {
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    if (!cancelled) {
      this.suppressClickUntil = Date.now() + BrightnessDragController.CLICK_SUPPRESS_MS;
    }

    this.pendingPct = g.pct;
    this.flush();
    this.host.onDragEnd(g.pct);
  }

  private handleClickCapture(e: Event): void {
    if (this.suppressClickUntil && Date.now() < this.suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
    this.suppressClickUntil = 0;
  }

  private queue(pct: number): void {
    this.pendingPct = pct;
    const wait = BrightnessDragController.THROTTLE_MS - (Date.now() - this.lastSentAt);
    if (wait <= 0) {
      this.flush();
    } else if (this.throttleTimer === undefined) {
      this.throttleTimer = window.setTimeout(() => this.flush(), wait);
    }
  }

  private flush(): void {
    this.clearThrottle();
    const pct = this.pendingPct;
    this.pendingPct = undefined;
    if (pct === undefined || pct === this.lastSentPct) return;
    this.lastSentPct = pct;
    this.lastSentAt = Date.now();
    this.host.onCommit(pct);
  }

  private clearThrottle(): void {
    if (this.throttleTimer !== undefined) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
  }
}
