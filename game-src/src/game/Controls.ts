import type { Input } from './types.ts';
import { clamp } from './Simulation.ts';

export class Controls {
  keys = new Set<string>();
  heading: number | null = null;
  paddle = false;
  stick: HTMLElement;
  knob: HTMLElement;
  resetPointers = () => {};
  constructor(stick: HTMLElement, paddle: HTMLElement, onPause: () => void, isPlaying: () => boolean) {
    this.stick = stick; this.knob = stick.querySelector('i')!;
    addEventListener('keydown', e => {
      if (['Escape', 'KeyP'].includes(e.code) && !e.repeat) { onPause(); return; }
      if (e.target instanceof HTMLElement && e.target.closest('button, a, input')) return;
      if (['KeyW', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) && isPlaying()) {
        e.preventDefault(); this.keys.add(e.code);
      }
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.clear());
    let pointer: number | null = null;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const rect = stick.getBoundingClientRect();
      const dx = e.clientX - rect.left - rect.width / 2, dy = e.clientY - rect.top - rect.height / 2;
      const len = Math.hypot(dx, dy), max = rect.width * .3, scale = Math.min(1, max / (len || 1));
      this.heading = len > 9 ? Math.atan2(dy, dx) : null;
      this.knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
    };
    stick.addEventListener('pointerdown', e => {
      if (pointer !== null) return;
      pointer = e.pointerId; stick.setPointerCapture(e.pointerId); move(e);
    });
    stick.addEventListener('pointermove', move);
    const releaseStick = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      pointer = null; this.heading = null; this.knob.style.transform = '';
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => stick.addEventListener(name, e => releaseStick(e as PointerEvent)));
    let paddlePointer: number | null = null;
    paddle.addEventListener('pointerdown', e => {
      if (paddlePointer !== null) return;
      paddlePointer = e.pointerId; paddle.setPointerCapture(e.pointerId); this.paddle = true; paddle.classList.add('held');
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => paddle.addEventListener(name, e => {
      if ((e as PointerEvent).pointerId !== paddlePointer) return;
      paddlePointer = null; this.paddle = false; paddle.classList.remove('held');
    }));
    this.resetPointers = () => {
      if (pointer !== null && stick.hasPointerCapture(pointer)) stick.releasePointerCapture(pointer);
      if (paddlePointer !== null && paddle.hasPointerCapture(paddlePointer)) paddle.releasePointerCapture(paddlePointer);
      pointer = null; paddlePointer = null; paddle.classList.remove('held');
    };
  }
  clear() { this.keys.clear(); this.heading = null; this.paddle = false; this.knob.style.transform = ''; this.resetPointers(); }
  read(): Input {
    const has = (...codes: string[]) => codes.some(k => this.keys.has(k));
    return {
      thrust: this.paddle || has('KeyW', 'ArrowUp', 'Space'),
      boost: has('Space'),
      turn: clamp(Number(has('KeyD', 'ArrowRight')) - Number(has('KeyA', 'ArrowLeft')), -1, 1),
      heading: this.heading,
    };
  }
}
