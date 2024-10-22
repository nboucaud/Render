import { Canvas } from "../../Canvas";
import { Engine } from "../../Engine";
import { Scene } from "../../Scene";
import { ClearableObjectPool } from "../../utils/ClearableObjectPool";
import { DisorderedArray } from "../../utils/DisorderedArray";
import { PointerButton, _pointerDec2BinMap } from "../enums/PointerButton";
import { PointerPhase } from "../enums/PointerPhase";
import { IInput } from "../interface/IInput";
import { Pointer, PointerEventType } from "./Pointer";
import { PointerEventData } from "./PointerEventData";
import { PointerPhysicsEventEmitter } from "./emitter/PointerPhysicsEventEmitter";
import { PointerUIEventEmitter } from "./emitter/PointerUIEventEmitter";

/**
 * Pointer Manager.
 * @internal
 */
export class PointerManager implements IInput {
  /** @internal */
  _pointers: Pointer[] = [];
  /** @internal */
  _multiPointerEnabled: boolean = true;
  /** @internal */
  _buttons: PointerButton = PointerButton.None;
  /** @internal */
  _upMap: number[] = [];
  /** @internal */
  _downMap: number[] = [];
  /** @internal */
  _upList: DisorderedArray<PointerButton> = new DisorderedArray();
  /** @internal */
  _downList: DisorderedArray<PointerButton> = new DisorderedArray();

  // @internal
  _target: EventTarget;
  private _engine: Engine;
  private _canvas: Canvas;
  private _nativeEvents: PointerEvent[] = [];
  private _pointerPool: Pointer[];
  private _htmlCanvas: HTMLCanvasElement;
  private _eventDataPool = new ClearableObjectPool(PointerEventData);

  /**
   * @internal
   */
  constructor(engine: Engine, target: EventTarget) {
    // Temporary solution for mini program, window does not exist
    if (typeof Window !== "undefined" && target instanceof Window) {
      throw "Do not set window as target because window cannot listen to pointer leave event.";
    }
    this._engine = engine;
    this._target = target;
    this._canvas = engine.canvas;
    // @ts-ignore
    this._htmlCanvas = engine._canvas._webCanvas;
    // If there are no compatibility issues, navigator.maxTouchPoints should be used here
    this._pointerPool = new Array<Pointer>(11);
    this._onPointerEvent = this._onPointerEvent.bind(this);
    this._addEventListener();
  }

  /**
   * @internal
   */
  _update(): void {
    const { _pointers, _nativeEvents, _htmlCanvas, _engine, _eventDataPool: _eventPool } = this;
    const { width, height } = this._canvas;
    const { clientWidth, clientHeight } = _htmlCanvas;
    const { left, top } = _htmlCanvas.getBoundingClientRect();
    const widthDPR = width / clientWidth;
    const heightDPR = height / clientHeight;

    // Clear the pointer event data pool
    _eventPool.clear();

    // Clean up the pointer released in the previous frame
    for (let i = _pointers.length - 1; i >= 0; i--) {
      const pointer = _pointers[i];
      if (pointer.phase === PointerPhase.Leave) {
        pointer._dispose();
        _pointers.splice(i, 1);
      } else {
        pointer._resetOnFrameBegin();
      }
    }

    // Generate the pointer received for this frame
    for (let i = 0, n = _nativeEvents.length; i < n; i++) {
      const evt = _nativeEvents[i];
      const { pointerId } = evt;
      let pointer = this._getPointerByID(pointerId);
      if (pointer) {
        pointer._events.push(evt);
      } else {
        const lastCount = _pointers.length;
        if (lastCount === 0 || this._multiPointerEnabled) {
          const { _pointerPool: pointerPool } = this;
          // Get Pointer smallest index
          let j = 0;
          for (; j < lastCount; j++) {
            if (_pointers[j].id > j) {
              break;
            }
          }
          pointer = pointerPool[j];
          if (!pointer) {
            pointer = new Pointer(j);
            pointer._addEmitters(PointerUIEventEmitter, _eventPool);
            _engine._physicsInitialized && pointer._addEmitters(PointerPhysicsEventEmitter, _eventPool);
          }
          pointer._uniqueID = pointerId;
          pointer._events.push(evt);
          pointer.position.set((evt.clientX - left) * widthDPR, (evt.clientY - top) * heightDPR);
          _pointers.splice(j, 0, pointer);
        }
      }
    }
    _nativeEvents.length = 0;

    this._upList.length = this._downList.length = 0;
    this._buttons = PointerButton.None;
    // Pointer handles its own events
    const frameCount = _engine.time.frameCount;
    for (let i = 0, n = _pointers.length; i < n; i++) {
      const pointer = _pointers[i];
      this._updatePointerInfo(frameCount, pointer, left, top, widthDPR, heightDPR);
      this._buttons |= pointer.pressedButtons;
    }
  }

  /**
   * @internal
   */
  _firePointerScript(scenes: readonly Scene[]) {
    const { _pointers: pointers } = this;
    for (let i = 0, n = pointers.length; i < n; i++) {
      const pointer = pointers[i];
      const { _events: events, _emitters: emitters } = pointer;
      emitters.forEach((emitter) => {
        emitter._processRaycast(scenes, pointer);
      });
      const length = events.length;
      if (length > 0) {
        if (pointer._frameEvents & PointerEventType.Move) {
          // `Drag` must be processed first, otherwise `EndDrag` may be triggered first.
          pointer.phase = PointerPhase.Move;
          emitters.forEach((emitter) => {
            emitter._processDrag(pointer);
          });
        }
        for (let j = 0; j < length; j++) {
          const event = events[j];
          switch (event.type) {
            case "pointerdown":
              pointer.phase = PointerPhase.Down;
              emitters.forEach((emitter) => {
                emitter._processDown(pointer);
              });
              break;
            case "pointerup":
              pointer.phase = PointerPhase.Up;
              emitters.forEach((emitter) => {
                emitter._processUp(pointer);
              });
              break;
            case "pointerleave":
            case "pointercancel":
              pointer.phase = PointerPhase.Leave;
              emitters.forEach((emitter) => {
                emitter._processLeave(pointer);
              });
              break;
          }
        }
        events.length = 0;
      }
    }
  }

  /**
   * @internal
   */
  _destroy(): void {
    this._removeEventListener();
    this._pointerPool.length = 0;
  }

  private _onPointerEvent(evt: PointerEvent) {
    this._nativeEvents.push(evt);
  }

  private _getPointerByID(pointerId: number): Pointer {
    const { _pointers: pointers } = this;
    for (let i = pointers.length - 1; i >= 0; i--) {
      if (pointers[i]._uniqueID === pointerId) {
        return pointers[i];
      }
    }
    return null;
  }

  private _updatePointerInfo(
    frameCount: number,
    pointer: Pointer,
    left: number,
    top: number,
    widthPixelRatio: number,
    heightPixelRatio: number
  ) {
    const { _events: events, position } = pointer;
    const length = events.length;
    if (length > 0) {
      const { _upList, _upMap, _downList, _downMap } = this;
      const latestEvent = events[length - 1];
      const currX = (latestEvent.clientX - left) * widthPixelRatio;
      const currY = (latestEvent.clientY - top) * heightPixelRatio;
      pointer.deltaPosition.set(currX - position.x, currY - position.y);
      position.set(currX, currY);
      for (let i = 0; i < length; i++) {
        const event = events[i];
        const { button } = event;
        pointer.button = _pointerDec2BinMap[button] || PointerButton.None;
        pointer.pressedButtons = event.buttons;
        switch (event.type) {
          case "pointerdown":
            _downList.add(button);
            _downMap[button] = frameCount;
            pointer._downList.add(button);
            pointer._downMap[button] = frameCount;
            pointer._frameEvents |= PointerEventType.Down;
            pointer.phase = PointerPhase.Down;
            break;
          case "pointerup":
            _upList.add(button);
            _upMap[button] = frameCount;
            pointer._upList.add(button);
            pointer._upMap[button] = frameCount;
            pointer._frameEvents |= PointerEventType.Up;
            pointer.phase = PointerPhase.Up;
            break;
          case "pointermove":
            pointer._frameEvents |= PointerEventType.Move;
            pointer.phase = PointerPhase.Move;
            break;
          case "pointerleave":
            pointer._frameEvents |= PointerEventType.Leave;
            pointer.phase = PointerPhase.Leave;
            break;
          case "pointercancel":
            pointer._frameEvents |= PointerEventType.Cancel;
            pointer.phase = PointerPhase.Leave;
            break;
          default:
            break;
        }
      }
    } else {
      pointer.deltaPosition.set(0, 0);
      pointer.phase = PointerPhase.Stationary;
    }
  }

  private _addEventListener(): void {
    const { _target: target, _onPointerEvent: onPointerEvent } = this;
    target.addEventListener("pointerdown", onPointerEvent);
    target.addEventListener("pointerup", onPointerEvent);
    target.addEventListener("pointerleave", onPointerEvent);
    target.addEventListener("pointermove", onPointerEvent);
    target.addEventListener("pointercancel", onPointerEvent);
  }

  private _removeEventListener(): void {
    const { _target: target, _onPointerEvent: onPointerEvent } = this;
    target.removeEventListener("pointerdown", onPointerEvent);
    target.removeEventListener("pointerup", onPointerEvent);
    target.removeEventListener("pointerleave", onPointerEvent);
    target.removeEventListener("pointermove", onPointerEvent);
    target.removeEventListener("pointercancel", onPointerEvent);
    this._eventDataPool.garbageCollection();
    this._nativeEvents.length = 0;
    this._pointers.length = 0;
    this._downList.length = 0;
    this._downMap.length = 0;
    this._upList.length = 0;
    this._upMap.length = 0;
  }
}
