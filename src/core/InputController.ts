export interface LookIntent {
  fireHeld: boolean;
  fireQueued: boolean;
}

/**
 * Quarter-view input: cursor/drag position aims on the ground plane,
 * hold-to-fire. No pointer lock, no camera rotation.
 */
export class InputController {
  private pointerX = 0;
  private pointerY = 0;
  private hasPointer = false;
  private fireHeld = false;
  private fireQueued = false;
  private touchAimId: number | null = null;

  private readonly intent: LookIntent = { fireHeld: false, fireQueued: false };

  private readonly onMouseMove = (event: MouseEvent) => {
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.hasPointer = true;
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) {
      this.fireHeld = true;
      this.fireQueued = true;
    }
  };

  private readonly onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) this.fireHeld = false;
  };

  private readonly onBlur = () => {
    this.fireHeld = false;
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    if (this.touchAimId !== null) return;
    this.touchAimId = event.pointerId;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.hasPointer = true;
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || event.pointerId !== this.touchAimId) return;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.hasPointer = true;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId === this.touchAimId) this.touchAimId = null;
  };

  private bind(el: HTMLElement, onDown: (down: boolean) => void): void {
    const down = (event: PointerEvent) => {
      event.preventDefault();
      onDown(true);
    };
    const up = (event: PointerEvent) => {
      event.preventDefault();
      onDown(false);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  constructor(fireButton: HTMLElement) {
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.bind(fireButton, (down) => {
      this.fireHeld = down;
      if (down) this.fireQueued = true;
    });
  }

  consumeLook(): LookIntent {
    this.intent.fireHeld = this.fireHeld;
    this.intent.fireQueued = this.fireQueued;
    this.fireQueued = false;
    return this.intent;
  }

  /** Screen-space aim position; has=false until a pointer event arrives. */
  readPointer(): { x: number; y: number; has: boolean } {
    return { x: this.pointerX, y: this.pointerY, has: this.hasPointer };
  }

  dispose(): void {
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }
}
