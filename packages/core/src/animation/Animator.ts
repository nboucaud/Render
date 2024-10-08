import { MathUtil } from "@galacean/engine-math";
import { BoolUpdateFlag } from "../BoolUpdateFlag";
import { Component } from "../Component";
import { Entity } from "../Entity";
import { Renderer } from "../Renderer";
import { Script } from "../Script";
import { Logger } from "../base/Logger";
import { assignmentClone, ignoreClone } from "../clone/CloneManager";
import { ClearableObjectPool } from "../utils/ClearableObjectPool";
import { AnimatorController } from "./AnimatorController";
import { AnimatorControllerLayer } from "./AnimatorControllerLayer";
import { AnimatorControllerParameter, AnimatorControllerParameterValue } from "./AnimatorControllerParameter";
import { AnimatorState } from "./AnimatorState";
import { AnimatorStateTransition } from "./AnimatorStateTransition";
import { AnimatorStateTransitionCollection } from "./AnimatorStateTransitionCollection";
import { KeyframeValueType } from "./Keyframe";
import { AnimatorConditionMode } from "./enums/AnimatorConditionMode";
import { AnimatorCullingMode } from "./enums/AnimatorCullingMode";
import { AnimatorLayerBlendingMode } from "./enums/AnimatorLayerBlendingMode";
import { AnimatorStatePlayState } from "./enums/AnimatorStatePlayState";
import { LayerState } from "./enums/LayerState";
import { AnimationCurveLayerOwner } from "./internal/AnimationCurveLayerOwner";
import { AnimationEventHandler } from "./internal/AnimationEventHandler";
import { AnimatorLayerData } from "./internal/AnimatorLayerData";
import { AnimatorStateData } from "./internal/AnimatorStateData";
import { AnimatorStatePlayData } from "./internal/AnimatorStatePlayData";
import { AnimationCurveOwner } from "./internal/animationCurveOwner/AnimationCurveOwner";
import { AnimationClipCurveBinding } from "./AnimationClipCurveBinding";
import { AnimationPropertyReferenceManager } from "./internal/AnimationPropertyReferenceManager";

/**
 * The controller of the animation system.
 */
export class Animator extends Component {
  private static _passedTriggerParameterNames = new Array<string>();

  /** Culling mode of this Animator. */
  cullingMode: AnimatorCullingMode = AnimatorCullingMode.None;
  /** The playback speed of the Animator, 1.0 is normal playback speed. */
  @assignmentClone
  speed = 1.0;

  /** @internal */
  _playFrameCount = -1;
  /** @internal */
  _onUpdateIndex = -1;

  protected _animatorController: AnimatorController;

  @ignoreClone
  protected _controllerUpdateFlag: BoolUpdateFlag;
  @ignoreClone
  protected _updateMark = 0;

  @ignoreClone
  private _animatorLayersData = new Array<AnimatorLayerData>();
  @ignoreClone
  private _curveOwnerPool: Record<number, Record<string, AnimationCurveOwner<KeyframeValueType>>> = Object.create(null);
  @ignoreClone
  private _animationEventHandlerPool = new ClearableObjectPool(AnimationEventHandler);
  @ignoreClone
  private _parametersValueMap = <Record<string, AnimatorControllerParameterValue>>Object.create(null);
  @ignoreClone
  private _tempAnimatorStateInfo: IAnimatorStateInfo = { layerIndex: -1, state: null };
  @ignoreClone
  private _controlledRenderers = new Array<Renderer>();
  @ignoreClone
  private _animationPropertyReferenceManager = new AnimationPropertyReferenceManager();

  /**
   * All layers from the AnimatorController which belongs this Animator.
   */
  get animatorController(): AnimatorController {
    return this._animatorController;
  }

  set animatorController(animatorController: AnimatorController) {
    if (animatorController !== this._animatorController) {
      this._reset();
      this._controllerUpdateFlag && this._controllerUpdateFlag.destroy();
      this._controllerUpdateFlag = animatorController && animatorController._registerChangeFlag();
      this._animatorController = animatorController;
    }
  }

  /**
   * The layers in the animator's controller.
   */
  get layers(): Readonly<AnimatorControllerLayer[]> {
    return this._animatorController?._layers;
  }

  /**
   * The parameters in the animator's controller.
   */
  get parameters(): Readonly<AnimatorControllerParameter[]> {
    return this._animatorController?._parameters;
  }

  /**
   * @internal
   */
  constructor(entity: Entity) {
    super(entity);
  }

  /**
   * Play a state by name.
   * @param stateName - The state name
   * @param layerIndex - The layer index(default -1). If layer is -1, play the first state with the given state name
   * @param normalizedTimeOffset - The normalized time offset (between 0 and 1, default 0) to start the state's animation from
   */
  play(stateName: string, layerIndex: number = -1, normalizedTimeOffset: number = 0): void {
    if (this._controllerUpdateFlag?.flag) {
      this._reset();
    }

    const stateInfo = this._getAnimatorStateInfo(stateName, layerIndex);
    const { state } = stateInfo;

    if (!state) {
      return;
    }

    if (this._preparePlay(state, stateInfo.layerIndex, normalizedTimeOffset)) {
      this._playFrameCount = this.engine.time.frameCount;
    }
  }

  /**
   * Create a cross fade from the current state to another state with a normalized duration.
   * @param stateName - The state name
   * @param normalizedDuration - The normalized duration of the transition, relative to the destination state's duration (range: 0 to 1)
   * @param layerIndex - The layer index(default -1). If layer is -1, play the first state with the given state name
   * @param normalizedTimeOffset - The normalized time offset (between 0 and 1, default 0) to start the destination state's animation from
   */
  crossFade(
    stateName: string,
    normalizedDuration: number,
    layerIndex: number = -1,
    normalizedTimeOffset: number = 0
  ): void {
    this._crossFade(stateName, normalizedDuration, layerIndex, normalizedTimeOffset, false);
  }

  /**
   * Create a cross fade from the current state to another state with a fixed duration.
   * @param stateName - The state name
   * @param fixedDuration - The duration of the transition in seconds
   * @param layerIndex - The layer index(default -1). If layer is -1, play the first state with the given state name
   * @param normalizedTimeOffset - The normalized time offset (between 0 and 1, default 0) to start the destination state's animation from
   */
  crossFadeInFixedDuration(
    stateName: string,
    fixedDuration: number,
    layerIndex: number = -1,
    normalizedTimeOffset: number = 0
  ): void {
    this._crossFade(stateName, fixedDuration, layerIndex, normalizedTimeOffset, true);
  }

  /**
   * Evaluates the animator component based on deltaTime.
   * @param deltaTime - The deltaTime when the animation update
   */
  update(deltaTime: number): void {
    // Play or crossFade in script, animation playing from the first frame, deltaTime should be 0
    if (this._playFrameCount === this.engine.time.frameCount) {
      deltaTime = 0;
    }

    let animationUpdate: boolean;
    if (this.cullingMode === AnimatorCullingMode.Complete) {
      animationUpdate = false;
      const controlledRenderers = this._controlledRenderers;
      for (let i = 0, n = controlledRenderers.length; i < n; i++) {
        if (!controlledRenderers[i].isCulled) {
          animationUpdate = true;
          break;
        }
      }
    } else {
      animationUpdate = true;
    }

    const animatorController = this._animatorController;
    if (!animatorController) {
      return;
    }

    if (this._controllerUpdateFlag?.flag) {
      this._reset();
    }

    this._updateMark++;

    const { layers } = animatorController;
    for (let i = 0, n = layers.length; i < n; i++) {
      const layerData = this._getAnimatorLayerData(i);
      this._updateState(layerData, deltaTime, animationUpdate);
    }
  }

  /**
   * Get the playing state from the target layerIndex.
   * @param layerIndex - The layer index
   */
  getCurrentAnimatorState(layerIndex: number): AnimatorState {
    return this._animatorLayersData[layerIndex]?.srcPlayData?.state;
  }

  /**
   * Get the state by name.
   * @param stateName - The state name
   * @param layerIndex - The layer index(default -1). If layer is -1, find the first state with the given state name
   */
  findAnimatorState(stateName: string, layerIndex: number = -1): AnimatorState {
    return this._getAnimatorStateInfo(stateName, layerIndex).state;
  }

  /**
   * Get the layer by name.
   * @param name - The layer's name.
   */
  findLayerByName(name: string): AnimatorControllerLayer {
    return this._animatorController?._layersMap[name];
  }

  /**
   * Get the parameter by name from animatorController.
   * @param name - The name of the parameter
   */
  getParameter(name: string): AnimatorControllerParameter {
    return this._animatorController?._parametersMap[name] ?? null;
  }

  /**
   * Get the value of the given parameter.
   * @param name - The name of the parameter
   * @param value - The value of the parameter
   */
  getParameterValue(name: string): AnimatorControllerParameterValue {
    const parameter = this._animatorController?._parametersMap[name];
    if (parameter) {
      return this._parametersValueMap[name] ?? parameter.defaultValue;
    }
    return undefined;
  }

  /**
   * Set the value of the given parameter.
   * @param name - The name of the parameter
   * @param value - The value of the parameter
   */
  setParameterValue(name: string, value: AnimatorControllerParameterValue): void {
    const parameter = this._animatorController?._parametersMap[name];
    if (parameter) {
      this._parametersValueMap[name] = value;
    }
  }

  /**
   * Activate the trigger parameter by name.
   * @param name - The name of the trigger parameter
   */
  activateTriggerParameter(name: string): void {
    const parameter = this._animatorController?._parametersMap[name];

    if (parameter?._isTrigger) {
      this._parametersValueMap[name] = true;
    }
  }

  /**
   * Reset the trigger parameter to deactivate it by name.
   * @param name - The name of the trigger parameter
   */
  deactivateTriggerParameter(name: string): void {
    const parameter = this._animatorController?._parametersMap[name];

    if (parameter?._isTrigger) {
      this._parametersValueMap[name] = false;
    }
  }

  /**
   * @internal
   */
  override _onEnable(): void {
    this._reset();
    this._entity.getComponentsIncludeChildren(Renderer, this._controlledRenderers);
  }

  /**
   * @internal
   */
  override _onEnableInScene(): void {
    this.scene._componentsManager.addOnUpdateAnimations(this);
  }
  /**
   * @internal
   */
  override _onDisableInScene(): void {
    this.scene._componentsManager.removeOnUpdateAnimations(this);
  }

  /**
   * @internal
   */
  _reset(): void {
    const { _curveOwnerPool: animationCurveOwners } = this;
    for (let instanceId in animationCurveOwners) {
      const propertyOwners = animationCurveOwners[instanceId];
      for (let property in propertyOwners) {
        const owner = propertyOwners[property];
        owner.revertDefaultValue();
      }
    }

    this._animatorLayersData.length = 0;
    this._curveOwnerPool = Object.create(null);
    this._parametersValueMap = Object.create(null);
    this._animationEventHandlerPool.clear();
    this._animationPropertyReferenceManager.clear();

    if (this._controllerUpdateFlag) {
      this._controllerUpdateFlag.flag = false;
    }
  }

  private _crossFade(
    stateName: string,
    duration: number,
    layerIndex: number,
    normalizedTimeOffset: number,
    isFixedDuration: boolean
  ): void {
    if (this._controllerUpdateFlag?.flag) {
      this._reset();
    }

    const { state, layerIndex: playLayerIndex } = this._getAnimatorStateInfo(stateName, layerIndex);
    const { manuallyTransition } = this._getAnimatorLayerData(playLayerIndex);
    manuallyTransition.duration = duration;

    manuallyTransition.offset = normalizedTimeOffset;
    manuallyTransition.isFixedDuration = isFixedDuration;
    manuallyTransition.destinationState = state;

    if (this._prepareCrossFadeByTransition(manuallyTransition, playLayerIndex)) {
      this._playFrameCount = this.engine.time.frameCount;
    }
  }

  private _getAnimatorStateInfo(stateName: string, layerIndex: number): IAnimatorStateInfo {
    const { _animatorController: animatorController, _tempAnimatorStateInfo: stateInfo } = this;
    let state: AnimatorState = null;
    if (animatorController) {
      const layers = animatorController.layers;
      if (layerIndex === -1) {
        for (let i = 0, n = layers.length; i < n; i++) {
          state = layers[i].stateMachine.findStateByName(stateName);
          if (state) {
            layerIndex = i;
            break;
          }
        }
      } else {
        state = layers[layerIndex].stateMachine.findStateByName(stateName);
      }
    }
    stateInfo.layerIndex = layerIndex;
    stateInfo.state = state;
    return stateInfo;
  }

  private _getAnimatorStateData(
    stateName: string,
    animatorState: AnimatorState,
    animatorLayerData: AnimatorLayerData,
    layerIndex: number
  ): AnimatorStateData {
    const { animatorStateDataMap } = animatorLayerData;
    let animatorStateData = animatorStateDataMap[stateName];
    if (!animatorStateData) {
      animatorStateData = new AnimatorStateData();
      animatorStateDataMap[stateName] = animatorStateData;
      this._saveAnimatorStateData(animatorState, animatorStateData, animatorLayerData, layerIndex);
      this._saveAnimatorEventHandlers(animatorState, animatorStateData);
    }
    return animatorStateData;
  }

  private _saveAnimatorStateData(
    animatorState: AnimatorState,
    animatorStateData: AnimatorStateData,
    animatorLayerData: AnimatorLayerData,
    layerIndex: number
  ): void {
    const { entity, _curveOwnerPool: curveOwnerPool } = this;
    let { mask } = this._animatorController.layers[layerIndex];
    const { curveLayerOwner } = animatorStateData;
    const { _curveBindings: curveBindings } = animatorState.clip;
    const { curveOwnerPool: layerCurveOwnerPool } = animatorLayerData;

    for (let i = 0, n = curveBindings.length; i < n; i++) {
      const curveBinding = curveBindings[i];
      const { relativePath } = curveBinding;
      const targetEntity = curveBinding.relativePath === "" ? entity : entity.findByPath(curveBinding.relativePath);

      if (targetEntity) {
        const component =
          curveBinding.typeIndex > 0
            ? targetEntity.getComponents(curveBinding.type, AnimationCurveOwner._components)[curveBinding.typeIndex]
            : targetEntity.getComponent(curveBinding.type);

        if (!component) {
          continue;
        }

        const { property } = curveBinding;
        const { instanceId } = component;
        // Get owner
        const propertyOwners = (curveOwnerPool[instanceId] ||= <Record<string, AnimationCurveOwner<KeyframeValueType>>>(
          Object.create(null)
        ));
        const owner = (propertyOwners[property] ||= curveBinding._createCurveOwner(
          this._animationPropertyReferenceManager,
          targetEntity,
          component
        ));

        // Get layer owner
        const layerPropertyOwners = (layerCurveOwnerPool[instanceId] ||= <Record<string, AnimationCurveLayerOwner>>(
          Object.create(null)
        ));
        const layerOwner = (layerPropertyOwners[property] ||= curveBinding._createCurveLayerOwner(owner));

        if (mask && mask.pathMasks.length) {
          layerOwner.isActive = mask.getPathMask(relativePath)?.active ?? true;
        }

        curveLayerOwner[i] = layerOwner;
      } else {
        curveLayerOwner[i] = null;
        Logger.warn(`The entity don\'t have the child entity which path is ${relativePath}.`);
      }
    }
  }

  private _saveAnimatorEventHandlers(state: AnimatorState, animatorStateData: AnimatorStateData): void {
    const eventHandlerPool = this._animationEventHandlerPool;
    const scripts = [];
    const { eventHandlers } = animatorStateData;

    const clipChangedListener = () => {
      this._entity.getComponents(Script, scripts);
      const scriptCount = scripts.length;
      const { events } = state.clip;
      eventHandlers.length = 0;
      for (let i = 0, n = events.length; i < n; i++) {
        const event = events[i];
        const eventHandler = eventHandlerPool.get();
        const funcName = event.functionName;
        const { handlers } = eventHandler;

        eventHandler.event = event;
        handlers.length = 0;
        for (let j = scriptCount - 1; j >= 0; j--) {
          const script = scripts[j];
          const handler = <Function>script[funcName].bind(script);
          handler && handlers.push(handler);
        }
        eventHandlers.push(eventHandler);
      }
    };
    clipChangedListener();
    state._updateFlagManager.addListener(clipChangedListener);
  }

  private _clearCrossData(animatorLayerData: AnimatorLayerData): void {
    animatorLayerData.crossCurveMark++;
    animatorLayerData.crossLayerOwnerCollection.length = 0;
  }

  private _addCrossOwner(
    animatorLayerData: AnimatorLayerData,
    layerOwner: AnimationCurveLayerOwner,
    curCurveIndex: number,
    nextCurveIndex: number
  ): void {
    layerOwner.crossSrcCurveIndex = curCurveIndex;
    layerOwner.crossDestCurveIndex = nextCurveIndex;
    animatorLayerData.crossLayerOwnerCollection.push(layerOwner);
  }

  private _prepareCrossFading(animatorLayerData: AnimatorLayerData): void {
    // Add src cross curve data
    this._prepareSrcCrossData(animatorLayerData, false);
    // Add dest cross curve data
    this._prepareDestCrossData(animatorLayerData, false);
  }

  private _prepareStandbyCrossFading(animatorLayerData: AnimatorLayerData): void {
    // Standby have two sub state, one is never play, one is finished, never play srcPlayData.state is null
    animatorLayerData.srcPlayData.state && this._prepareSrcCrossData(animatorLayerData, true);
    // Add dest cross curve data
    this._prepareDestCrossData(animatorLayerData, true);
  }

  private _prepareFixedPoseCrossFading(animatorLayerData: AnimatorLayerData): void {
    const { crossLayerOwnerCollection } = animatorLayerData;

    // Save current cross curve data owner fixed pose
    for (let i = 0, n = crossLayerOwnerCollection.length; i < n; i++) {
      const layerOwner = crossLayerOwnerCollection[i];
      if (!layerOwner) continue;
      layerOwner.curveOwner.saveFixedPoseValue();
      // Reset destCurveIndex When fixed pose crossFading again
      layerOwner.crossDestCurveIndex = -1;
    }
    // Prepare dest AnimatorState cross data
    this._prepareDestCrossData(animatorLayerData, true);
  }

  private _prepareSrcCrossData(animatorLayerData: AnimatorLayerData, saveFixed: boolean): void {
    const { curveLayerOwner } = animatorLayerData.srcPlayData.stateData;
    for (let i = 0, n = curveLayerOwner.length; i < n; i++) {
      const layerOwner = curveLayerOwner[i];
      if (!layerOwner) continue;
      layerOwner.crossCurveMark = animatorLayerData.crossCurveMark;
      saveFixed && layerOwner.curveOwner.saveFixedPoseValue();
      this._addCrossOwner(animatorLayerData, layerOwner, i, -1);
    }
  }

  private _prepareDestCrossData(animatorLayerData: AnimatorLayerData, saveFixed: boolean): void {
    const { curveLayerOwner } = animatorLayerData.destPlayData.stateData;
    for (let i = 0, n = curveLayerOwner.length; i < n; i++) {
      const layerOwner = curveLayerOwner[i];
      if (!layerOwner) continue;
      if (layerOwner.crossCurveMark === animatorLayerData.crossCurveMark) {
        layerOwner.crossDestCurveIndex = i;
      } else {
        const owner = layerOwner.curveOwner;
        saveFixed && owner.saveFixedPoseValue();
        layerOwner.crossCurveMark = animatorLayerData.crossCurveMark;
        this._addCrossOwner(animatorLayerData, layerOwner, -1, i);
      }
    }
  }

  private _getAnimatorLayerData(layerIndex: number): AnimatorLayerData {
    let animatorLayerData = this._animatorLayersData[layerIndex];
    if (!animatorLayerData) {
      animatorLayerData = new AnimatorLayerData();
      animatorLayerData.layerIndex = layerIndex;
      animatorLayerData.layer = this._animatorController.layers[layerIndex];
      this._animatorLayersData[layerIndex] = animatorLayerData;
    }
    return animatorLayerData;
  }

  private _updateState(layerData: AnimatorLayerData, deltaTime: number, aniUpdate: boolean): void {
    const { layer } = layerData;
    let { weight } = layer;
    const additive = layer.blendingMode === AnimatorLayerBlendingMode.Additive;

    layerData.layerIndex === 0 && (weight = 1.0);

    switch (layerData.layerState) {
      case LayerState.Standby:
        this._checkAnyAndEntryState(layerData, deltaTime, aniUpdate);
        break;
      case LayerState.Playing:
        this._updatePlayingState(layerData, weight, additive, deltaTime, aniUpdate);
        break;
      case LayerState.Finished:
        this._updateFinishedState(layerData, weight, additive, deltaTime, aniUpdate);
        break;
      case LayerState.CrossFading:
        this._updateCrossFadeState(layerData, weight, additive, deltaTime, aniUpdate);
        break;
      case LayerState.FixedCrossFading:
        this._updateCrossFadeFromPoseState(layerData, weight, additive, deltaTime, aniUpdate);
        break;
    }
  }

  private _updatePlayingState(
    layerData: AnimatorLayerData,
    weight: number,
    additive: boolean,
    deltaTime: number,
    aniUpdate: boolean
  ): void {
    const { srcPlayData } = layerData;
    const { state } = srcPlayData;

    const playSpeed = state.speed * this.speed;
    const playDeltaTime = playSpeed * deltaTime;

    srcPlayData.updateOrientation(playDeltaTime);

    const { clipTime: lastClipTime, playState: lastPlayState } = srcPlayData;

    // Precalculate to get the transition
    srcPlayData.update(playDeltaTime);

    const { clipTime, isForwards } = srcPlayData;
    const { _transitionCollection: transitions } = state;
    const { _anyStateTransitionCollection: anyStateTransitions } = layerData.layer.stateMachine;

    const transition =
      (anyStateTransitions.count &&
        this._applyStateTransitions(
          layerData,
          isForwards,
          srcPlayData,
          anyStateTransitions,
          lastClipTime,
          clipTime,
          playDeltaTime,
          true,
          aniUpdate
        )) ||
      (transitions.count &&
        this._applyStateTransitions(
          layerData,
          isForwards,
          srcPlayData,
          transitions,
          lastClipTime,
          clipTime,
          playDeltaTime,
          false,
          aniUpdate
        ));

    let playCostTime: number;
    if (transition) {
      const clipDuration = state.clip.length;
      const clipEndTime = state.clipEndTime * clipDuration;

      if (transition.hasExitTime) {
        const exitTime = transition.exitTime * state._getDuration();

        if (isForwards) {
          if (exitTime < lastClipTime) {
            playCostTime = exitTime + clipEndTime - lastClipTime;
          } else {
            playCostTime = exitTime - lastClipTime;
          }
        } else {
          const startTime = state.clipStartTime * clipDuration;
          if (lastClipTime < exitTime) {
            playCostTime = clipEndTime - exitTime + lastClipTime - startTime;
          } else {
            playCostTime = lastClipTime - exitTime;
          }
          playCostTime = -playCostTime;
        }
      } else {
        playCostTime = 0;
      }
      // Revert actualDeltaTime and update playCostTime
      srcPlayData.update(playCostTime - playDeltaTime);
    } else {
      playCostTime = playDeltaTime;
      if (srcPlayData.playState === AnimatorStatePlayState.Finished) {
        layerData.layerState = LayerState.Finished;
      }
    }

    this._evaluatePlayingState(srcPlayData, weight, additive, aniUpdate);
    this._fireAnimationEventsAndCallScripts(
      layerData.layerIndex,
      srcPlayData,
      state,
      lastClipTime,
      lastPlayState,
      playCostTime
    );

    if (transition) {
      // Remove speed factor, use actual cost time
      const remainDeltaTime = deltaTime - playCostTime / playSpeed;
      remainDeltaTime > 0 && this._updateState(layerData, remainDeltaTime, aniUpdate);
    }
  }

  private _evaluatePlayingState(
    playData: AnimatorStatePlayData,
    weight: number,
    additive: boolean,
    aniUpdate: boolean
  ): void {
    const curveBindings = playData.state.clip._curveBindings;
    const finished = playData.playState === AnimatorStatePlayState.Finished;

    if (aniUpdate || finished) {
      const curveLayerOwner = playData.stateData.curveLayerOwner;
      for (let i = 0, n = curveBindings.length; i < n; i++) {
        const layerOwner = curveLayerOwner[i];
        const owner = layerOwner?.curveOwner;

        if (!owner || !layerOwner.isActive) {
          continue;
        }

        const curve = curveBindings[i].curve;
        if (curve.keys.length) {
          this._checkRevertOwner(owner, additive);

          const value = owner.evaluateValue(curve, playData.clipTime, additive);
          aniUpdate && owner.applyValue(value, weight, additive);
          finished && layerOwner.saveFinalValue();
        }
      }
    }
  }

  private _updateCrossFadeState(
    layerData: AnimatorLayerData,
    weight: number,
    additive: boolean,
    deltaTime: number,
    aniUpdate: boolean
  ) {
    const { srcPlayData, destPlayData, layerIndex } = layerData;
    const { speed } = this;
    const { state: srcState } = srcPlayData;
    const { state: destState } = destPlayData;
    const transitionDuration = layerData.crossFadeTransition._getFixedDuration();

    const srcPlaySpeed = srcState.speed * speed;
    const dstPlaySpeed = destState.speed * speed;
    const dstPlayDeltaTime = dstPlaySpeed * deltaTime;

    srcPlayData && srcPlayData.updateOrientation(srcPlaySpeed * deltaTime);
    destPlayData && destPlayData.updateOrientation(dstPlayDeltaTime);

    const { clipTime: lastSrcClipTime, playState: lastSrcPlayState } = srcPlayData;
    const { clipTime: lastDestClipTime, playState: lastDstPlayState } = destPlayData;

    let dstPlayCostTime: number;
    if (destPlayData.isForwards) {
      // The time that has been played
      const playedTime = lastDestClipTime - destState.clipStartTime * destState.clip.length;
      dstPlayCostTime =
        playedTime + dstPlayDeltaTime > transitionDuration ? transitionDuration - playedTime : dstPlayDeltaTime;
    } else {
      // The time that has been played
      const playedTime = destState.clipEndTime * destState.clip.length - lastDestClipTime;
      dstPlayCostTime =
        // -dstPlayDeltaTime: The time that will be played, negative are meant to make it be a periods
        // > transition: The time that will be played is enough to finish the transition
        playedTime - dstPlayDeltaTime > transitionDuration
          ? // Negative number is used to convert a time period into a reverse deltaTime.
            // -(transitionDuration - playedTime)
            playedTime - transitionDuration
          : dstPlayDeltaTime;
    }

    const actualCostTime = dstPlaySpeed === 0 ? deltaTime : dstPlayCostTime / dstPlaySpeed;
    const srcPlayCostTime = actualCostTime * srcPlaySpeed;

    srcPlayData.update(srcPlayCostTime);
    destPlayData.update(dstPlayCostTime);

    let crossWeight = Math.abs(destPlayData.frameTime) / transitionDuration;
    (crossWeight >= 1.0 - MathUtil.zeroTolerance || transitionDuration === 0) && (crossWeight = 1.0);

    const crossFadeFinished = crossWeight === 1.0;

    if (crossFadeFinished) {
      srcPlayData.playState = AnimatorStatePlayState.Finished;
      this._preparePlayOwner(layerData, destState);
      this._evaluatePlayingState(destPlayData, weight, additive, aniUpdate);
    } else {
      this._evaluateCrossFadeState(layerData, srcPlayData, destPlayData, weight, crossWeight, additive, aniUpdate);
    }

    this._fireAnimationEventsAndCallScripts(
      layerIndex,
      srcPlayData,
      srcState,
      lastSrcClipTime,
      lastSrcPlayState,
      srcPlayCostTime
    );

    this._fireAnimationEventsAndCallScripts(
      layerIndex,
      destPlayData,
      destState,
      lastDestClipTime,
      lastDstPlayState,
      dstPlayCostTime
    );

    if (crossFadeFinished) {
      this._updateCrossFadeData(layerData);
      const remainDeltaTime = deltaTime - actualCostTime;
      remainDeltaTime > 0 && this._updateState(layerData, remainDeltaTime, aniUpdate);
    }
  }

  private _evaluateCrossFadeState(
    layerData: AnimatorLayerData,
    srcPlayData: AnimatorStatePlayData,
    destPlayData: AnimatorStatePlayData,
    weight: number,
    crossWeight: number,
    additive: boolean,
    aniUpdate: boolean
  ) {
    const { crossLayerOwnerCollection } = layerData;
    const { _curveBindings: srcCurves } = srcPlayData.state.clip;
    const { state: destState } = destPlayData;
    const { _curveBindings: destCurves } = destState.clip;

    const finished = destPlayData.playState === AnimatorStatePlayState.Finished;

    if (aniUpdate || finished) {
      for (let i = 0, n = crossLayerOwnerCollection.length; i < n; i++) {
        const layerOwner = crossLayerOwnerCollection[i];
        const owner = layerOwner?.curveOwner;

        if (!owner) continue;

        const srcCurveIndex = layerOwner.crossSrcCurveIndex;
        const destCurveIndex = layerOwner.crossDestCurveIndex;

        this._checkRevertOwner(owner, additive);

        const value = owner.evaluateCrossFadeValue(
          srcCurveIndex >= 0 ? srcCurves[srcCurveIndex].curve : null,
          destCurveIndex >= 0 ? destCurves[destCurveIndex].curve : null,
          srcPlayData.clipTime,
          destPlayData.clipTime,
          crossWeight,
          additive
        );
        aniUpdate && owner.applyValue(value, weight, additive);
        finished && layerOwner.saveFinalValue();
      }
    }
  }

  private _updateCrossFadeFromPoseState(
    layerData: AnimatorLayerData,
    weight: number,
    additive: boolean,
    deltaTime: number,
    aniUpdate: boolean
  ) {
    const { destPlayData } = layerData;
    const { state } = destPlayData;

    const transitionDuration = layerData.crossFadeTransition._getFixedDuration();

    const playSpeed = state.speed * this.speed;
    const playDeltaTime = playSpeed * deltaTime;

    destPlayData.updateOrientation(playDeltaTime);

    const { clipTime: lastDestClipTime, playState: lastPlayState } = destPlayData;

    let dstPlayCostTime: number;
    if (destPlayData.isForwards) {
      dstPlayCostTime =
        lastDestClipTime + playDeltaTime > transitionDuration ? transitionDuration - lastDestClipTime : playDeltaTime;
    } else {
      // The time that has been played
      const playedTime = state._getDuration() - lastDestClipTime;
      dstPlayCostTime =
        // -playDeltaTime: The time that will be played, negative are meant to make it be a periods
        // > transition: The time that will be played is enough to finish the transition
        playedTime - playDeltaTime > transitionDuration
          ? // Negative number is used to convert a time period into a reverse deltaTime.
            // -(transitionDuration - playedTime)
            playedTime - transitionDuration
          : playDeltaTime;
    }

    const actualCostTime = playSpeed === 0 ? deltaTime : dstPlayCostTime / playSpeed;

    destPlayData.update(dstPlayCostTime);

    let crossWeight = Math.abs(destPlayData.frameTime) / transitionDuration;
    (crossWeight >= 1.0 - MathUtil.zeroTolerance || transitionDuration === 0) && (crossWeight = 1.0);

    const crossFadeFinished = crossWeight === 1.0;

    if (crossFadeFinished) {
      this._preparePlayOwner(layerData, state);
      this._evaluatePlayingState(destPlayData, weight, additive, aniUpdate);
    } else {
      this._evaluateCrossFadeFromPoseState(layerData, destPlayData, weight, crossWeight, additive, aniUpdate);
    }

    this._fireAnimationEventsAndCallScripts(
      layerData.layerIndex,
      destPlayData,
      state,
      lastDestClipTime,
      lastPlayState,
      dstPlayCostTime
    );

    if (crossFadeFinished) {
      this._updateCrossFadeData(layerData);
      const remainDeltaTime = deltaTime - actualCostTime;
      remainDeltaTime > 0 && this._updateState(layerData, remainDeltaTime, aniUpdate);
    }
  }

  private _evaluateCrossFadeFromPoseState(
    layerData: AnimatorLayerData,
    destPlayData: AnimatorStatePlayData,
    weight: number,
    crossWeight: number,
    additive: boolean,
    aniUpdate: boolean
  ) {
    const { crossLayerOwnerCollection } = layerData;
    const { state } = destPlayData;
    const { _curveBindings: curveBindings } = state.clip;

    const { clipTime: destClipTime, playState } = destPlayData;
    const finished = playState === AnimatorStatePlayState.Finished;

    // When the animator is culled (aniUpdate=false), if the play state has finished, the final value needs to be calculated and saved to be applied directly
    if (aniUpdate || finished) {
      for (let i = 0, n = crossLayerOwnerCollection.length; i < n; i++) {
        const layerOwner = crossLayerOwnerCollection[i];
        const owner = layerOwner?.curveOwner;

        if (!owner) continue;

        const curveIndex = layerOwner.crossDestCurveIndex;

        this._checkRevertOwner(owner, additive);

        const value = layerOwner.curveOwner.crossFadeFromPoseAndApplyValue(
          curveIndex >= 0 ? curveBindings[curveIndex].curve : null,
          destClipTime,
          crossWeight,
          additive
        );
        aniUpdate && owner.applyValue(value, weight, additive);
        finished && layerOwner.saveFinalValue();
      }
    }
  }

  private _updateFinishedState(
    layerData: AnimatorLayerData,
    weight: number,
    additive: boolean,
    deltaTime: number,
    aniUpdate: boolean
  ): void {
    const playData = layerData.srcPlayData;
    const { state } = playData;
    const actualSpeed = state.speed * this.speed;
    const actualDeltaTime = actualSpeed * deltaTime;

    playData.updateOrientation(actualDeltaTime);

    const { clipTime, isForwards } = playData;
    const { _transitionCollection: transitions } = state;
    const { _anyStateTransitionCollection: anyStateTransitions } = layerData.layer.stateMachine;

    const transition =
      (anyStateTransitions.count && this._applyTransitionsByCondition(layerData, anyStateTransitions, aniUpdate)) ||
      (transitions.count &&
        this._applyStateTransitions(
          layerData,
          isForwards,
          playData,
          transitions,
          clipTime,
          clipTime,
          actualDeltaTime,
          false,
          aniUpdate
        ));

    if (transition) {
      this._updateState(layerData, deltaTime, aniUpdate);
    } else {
      this._evaluateFinishedState(playData, weight, additive, aniUpdate);
    }
  }

  private _evaluateFinishedState(
    playData: AnimatorStatePlayData,
    weight: number,
    additive: boolean,
    aniUpdate: boolean
  ): void {
    if (!aniUpdate) {
      return;
    }

    const { curveLayerOwner } = playData.stateData;
    const { _curveBindings: curveBindings } = playData.state.clip;

    for (let i = 0, n = curveBindings.length; i < n; i++) {
      const layerOwner = curveLayerOwner[i];
      const owner = layerOwner?.curveOwner;

      if (!owner) continue;

      this._checkRevertOwner(owner, additive);

      owner.applyValue(layerOwner.finalValue, weight, additive);
    }
  }

  private _updateCrossFadeData(layerData: AnimatorLayerData): void {
    const { destPlayData } = layerData;
    if (destPlayData.playState === AnimatorStatePlayState.Finished) {
      layerData.layerState = LayerState.Finished;
    } else {
      layerData.layerState = LayerState.Playing;
    }
    layerData.switchPlayData();
    layerData.crossFadeTransition = null;
  }

  private _preparePlayOwner(layerData: AnimatorLayerData, playState: AnimatorState): void {
    if (layerData.layerState === LayerState.Playing) {
      const srcPlayData = layerData.srcPlayData;
      if (srcPlayData.state !== playState) {
        const { curveLayerOwner } = srcPlayData.stateData;
        for (let i = 0, n = curveLayerOwner.length; i < n; i++) {
          curveLayerOwner[i]?.curveOwner.revertDefaultValue();
        }
      }
    } else {
      const { crossLayerOwnerCollection } = layerData;
      for (let i = 0, n = crossLayerOwnerCollection.length; i < n; i++) {
        crossLayerOwnerCollection[i].curveOwner.revertDefaultValue();
      }
    }
  }

  private _applyStateTransitions(
    layerData: AnimatorLayerData,
    isForwards: boolean,
    playData: AnimatorStatePlayData,
    transitions: AnimatorStateTransitionCollection,
    lastClipTime: number,
    clipTime: number,
    deltaTime: number,
    checkStateMachine: boolean,
    aniUpdate: boolean
  ): AnimatorStateTransition {
    const { state } = playData;
    const clipDuration = state.clip.length;
    let targetTransition: AnimatorStateTransition = null;
    const startTime = state.clipStartTime * clipDuration;
    const endTime = state.clipEndTime * clipDuration;
    if (isForwards) {
      if (lastClipTime + deltaTime >= endTime) {
        targetTransition = this._checkSubTransition(
          layerData,
          playData,
          transitions,
          lastClipTime,
          endTime,
          checkStateMachine,
          aniUpdate
        );
        if (!targetTransition) {
          if (checkStateMachine) {
            layerData.anyTransitionIndex = 0;
          } else {
            playData.currentTransitionIndex = 0;
          }
          targetTransition = this._checkSubTransition(
            layerData,
            playData,
            transitions,
            startTime,
            clipTime,
            checkStateMachine,
            aniUpdate
          );
        }
      } else {
        targetTransition = this._checkSubTransition(
          layerData,
          playData,
          transitions,
          lastClipTime,
          clipTime,
          checkStateMachine,
          aniUpdate
        );
      }
    } else {
      //@todo backwards play currentIndex should not be 0
      if (lastClipTime + deltaTime <= startTime) {
        targetTransition = this._checkBackwardsSubTransition(
          layerData,
          playData,
          transitions,
          lastClipTime,
          startTime,
          checkStateMachine,
          aniUpdate
        );
        if (!targetTransition) {
          if (checkStateMachine) {
            layerData.anyTransitionIndex = transitions.count - 1;
          } else {
            playData.currentTransitionIndex = transitions.count - 1;
          }
          targetTransition = this._checkBackwardsSubTransition(
            layerData,
            playData,
            transitions,
            clipTime,
            endTime,
            checkStateMachine,
            aniUpdate
          );
        }
      } else {
        targetTransition = this._checkBackwardsSubTransition(
          layerData,
          playData,
          transitions,
          lastClipTime,
          clipTime,
          checkStateMachine,
          aniUpdate
        );
      }
    }

    return targetTransition;
  }

  private _checkSubTransition(
    layerData: AnimatorLayerData,
    playData: AnimatorStatePlayData,
    transitions: AnimatorStateTransitionCollection,
    lastClipTime: number,
    curClipTime: number,
    checkStateMachine: boolean,
    aniUpdate: boolean
  ): AnimatorStateTransition {
    let transitionIndex = checkStateMachine ? layerData.anyTransitionIndex : playData.currentTransitionIndex;
    const duration = playData.state._getDuration();
    const isSoloMode = transitions.isSoloMode;
    for (let n = transitions.count; transitionIndex < n; transitionIndex++) {
      const transition = transitions.get(transitionIndex);
      const hasExitTime = transition.hasExitTime;
      const exitTime = transition.exitTime * duration;
      if (hasExitTime && exitTime > curClipTime) {
        break;
      }

      if (exitTime >= lastClipTime || !hasExitTime) {
        if (checkStateMachine) {
          layerData.anyTransitionIndex = Math.min(transitionIndex + 1, n - 1);
        } else {
          playData.currentTransitionIndex = Math.min(transitionIndex + 1, n - 1);
        }

        if (transition.mute) continue;

        if (isSoloMode && !transition.solo) continue;

        if (this._checkConditions(transition)) {
          if (this._applyTransition(layerData, transition, aniUpdate)) {
            return transition;
          } else {
            return null;
          }
        }
      }
    }
    return null;
  }

  private _checkBackwardsSubTransition(
    layerData: AnimatorLayerData,
    playState: AnimatorStatePlayData,
    transitions: AnimatorStateTransitionCollection,
    lastClipTime: number,
    curClipTime: number,
    checkStateMachine: boolean,
    aniUpdate: boolean
  ): AnimatorStateTransition {
    let transitionIndex = checkStateMachine ? layerData.anyTransitionIndex : playState.currentTransitionIndex;
    const duration = playState.state._getDuration();
    const isSoloMode = transitions.isSoloMode;
    for (; transitionIndex >= 0; transitionIndex--) {
      const transition = transitions.get(transitionIndex);
      const hasExitTime = transition.hasExitTime;
      const exitTime = transition.exitTime * duration;
      if (hasExitTime && exitTime < curClipTime) {
        break;
      }

      if (exitTime <= lastClipTime || !hasExitTime) {
        if (checkStateMachine) {
          layerData.anyTransitionIndex = Math.max(transitionIndex - 1, 0);
        } else {
          playState.currentTransitionIndex = Math.max(transitionIndex - 1, 0);
        }

        if (transition.mute) continue;

        if (isSoloMode && !transition.solo) continue;

        if (this._checkConditions(transition)) {
          if (this._applyTransition(layerData, transition, aniUpdate)) {
            return transition;
          } else {
            return null;
          }
        }
      }
    }
    return null;
  }

  private _applyTransitionsByCondition(
    layerData: AnimatorLayerData,
    transitions: AnimatorStateTransitionCollection,
    aniUpdate: boolean
  ): AnimatorStateTransition {
    const isSoloMode = transitions.isSoloMode;
    for (let i = 0, n = transitions.count; i < n; i++) {
      const transition = transitions.get(i);

      if (transition.mute) continue;

      if (isSoloMode && !transition.solo) continue;

      if (this._checkConditions(transition)) {
        if (this._applyTransition(layerData, transition, aniUpdate)) {
          return transition;
        } else {
          return null;
        }
      }
    }
  }

  private _preparePlay(state: AnimatorState, layerIndex: number, normalizedTimeOffset: number = 0): boolean {
    const name = state.name;
    if (!state.clip) {
      Logger.warn(`The state named ${name} has no AnimationClip data.`);
      return false;
    }

    const animatorLayerData = this._getAnimatorLayerData(layerIndex);
    const animatorStateData = this._getAnimatorStateData(name, state, animatorLayerData, layerIndex);

    this._preparePlayOwner(animatorLayerData, state);

    animatorLayerData.layerState = LayerState.Playing;
    animatorLayerData.srcPlayData.reset(state, animatorStateData, state._getDuration() * normalizedTimeOffset);

    return true;
  }

  private _applyTransition(
    layerData: AnimatorLayerData,
    transition: AnimatorStateTransition,
    aniUpdate: boolean
  ): boolean {
    // Need prepare first, it should crossFade when to exit
    const success = this._prepareCrossFadeByTransition(transition, layerData.layerIndex);
    if (transition.isExit) {
      this._checkAnyAndEntryState(layerData, 0, aniUpdate);
      return true;
    }
    return success;
  }

  private _checkConditions(transition: AnimatorStateTransition): boolean {
    const { conditions } = transition;

    let allPass = true;
    for (let i = 0, n = conditions.length; i < n; ++i) {
      let pass = false;
      const { mode, parameterName: name, threshold } = conditions[i];
      const parameterValue = this.getParameterValue(name);

      if (parameterValue === undefined) {
        return false;
      }

      if (parameterValue === true) {
        const parameter = this.getParameter(name);
        if (parameter?._isTrigger) {
          Animator._passedTriggerParameterNames.push(name);
          pass = true;
        }
      }

      if (!pass) {
        switch (mode) {
          case AnimatorConditionMode.Equals:
            if (parameterValue === threshold) {
              pass = true;
            }
            break;
          case AnimatorConditionMode.Greater:
            if (parameterValue > threshold) {
              pass = true;
            }
            break;
          case AnimatorConditionMode.Less:
            if (parameterValue < threshold) {
              pass = true;
            }
            break;
          case AnimatorConditionMode.NotEquals:
            if (parameterValue !== threshold) {
              pass = true;
            }
            break;
          case AnimatorConditionMode.If:
            if (parameterValue === true) {
              pass = true;
            }
            break;
          case AnimatorConditionMode.IfNot:
            if (parameterValue === false) {
              pass = true;
            }
            break;
        }
      }

      if (!pass) {
        allPass = false;
        break;
      }
    }

    if (allPass) {
      this._deactivateTriggeredParameters();
    }

    Animator._passedTriggerParameterNames.length = 0;

    return allPass;
  }

  private _prepareCrossFadeByTransition(transition: AnimatorStateTransition, layerIndex: number): boolean {
    const crossState = transition.destinationState;

    if (!crossState) {
      return false;
    }
    if (!crossState.clip) {
      Logger.warn(`The state named ${crossState.name} has no AnimationClip data.`);
      return false;
    }

    const animatorLayerData = this._getAnimatorLayerData(layerIndex);
    const animatorStateData = this._getAnimatorStateData(crossState.name, crossState, animatorLayerData, layerIndex);

    animatorLayerData.destPlayData.reset(crossState, animatorStateData, transition.offset * crossState._getDuration());

    switch (animatorLayerData.layerState) {
      case LayerState.Standby:
      case LayerState.Finished:
        animatorLayerData.layerState = LayerState.FixedCrossFading;
        this._clearCrossData(animatorLayerData);
        this._prepareStandbyCrossFading(animatorLayerData);
        break;
      case LayerState.Playing:
        animatorLayerData.layerState = LayerState.CrossFading;
        this._clearCrossData(animatorLayerData);
        this._prepareCrossFading(animatorLayerData);
        break;
      case LayerState.CrossFading:
        animatorLayerData.layerState = LayerState.FixedCrossFading;
        this._prepareFixedPoseCrossFading(animatorLayerData);
        break;
      case LayerState.FixedCrossFading:
        this._prepareFixedPoseCrossFading(animatorLayerData);
        break;
    }

    animatorLayerData.crossFadeTransition = transition;

    return true;
  }

  private _fireAnimationEvents(
    playData: AnimatorStatePlayData,
    eventHandlers: AnimationEventHandler[],
    lastClipTime: number,
    deltaTime: number
  ): void {
    const { state, isForwards, clipTime } = playData;
    const clipDuration = state.clip.length;
    const startTime = state.clipStartTime * clipDuration;
    const endTime = state.clipEndTime * clipDuration;

    if (isForwards) {
      if (lastClipTime + deltaTime >= endTime) {
        this._fireSubAnimationEvents(playData, eventHandlers, lastClipTime, state.clipEndTime * clipDuration);
        playData.currentEventIndex = 0;
        this._fireSubAnimationEvents(playData, eventHandlers, state.clipStartTime * clipDuration, clipTime);
      } else {
        this._fireSubAnimationEvents(playData, eventHandlers, lastClipTime, clipTime);
      }
    } else {
      if (lastClipTime + deltaTime <= startTime) {
        this._fireBackwardSubAnimationEvents(playData, eventHandlers, lastClipTime, state.clipStartTime * clipDuration);
        playData.currentEventIndex = eventHandlers.length - 1;
        this._fireBackwardSubAnimationEvents(playData, eventHandlers, state.clipEndTime * clipDuration, clipTime);
      } else {
        this._fireBackwardSubAnimationEvents(playData, eventHandlers, lastClipTime, clipTime);
      }
    }
  }

  private _fireSubAnimationEvents(
    playState: AnimatorStatePlayData,
    eventHandlers: AnimationEventHandler[],
    lastClipTime: number,
    curClipTime: number
  ): void {
    let eventIndex = playState.currentEventIndex;
    for (let n = eventHandlers.length; eventIndex < n; eventIndex++) {
      const eventHandler = eventHandlers[eventIndex];
      const { time, parameter } = eventHandler.event;

      if (time > curClipTime) {
        break;
      }

      const { handlers } = eventHandler;
      if (time >= lastClipTime) {
        for (let j = handlers.length - 1; j >= 0; j--) {
          handlers[j](parameter);
        }
        playState.currentEventIndex = Math.min(eventIndex + 1, n - 1);
      }
    }
  }

  private _fireBackwardSubAnimationEvents(
    playState: AnimatorStatePlayData,
    eventHandlers: AnimationEventHandler[],
    lastClipTime: number,
    curClipTime: number
  ): void {
    let eventIndex = playState.currentEventIndex;
    for (; eventIndex >= 0; eventIndex--) {
      const eventHandler = eventHandlers[eventIndex];
      const { time, parameter } = eventHandler.event;

      if (time < curClipTime) {
        break;
      }

      if (time <= lastClipTime) {
        const { handlers } = eventHandler;
        for (let j = handlers.length - 1; j >= 0; j--) {
          handlers[j](parameter);
        }
        playState.currentEventIndex = Math.max(eventIndex - 1, 0);
      }
    }
  }

  private _callAnimatorScriptOnEnter(state: AnimatorState, layerIndex: number): void {
    const scripts = state._onStateEnterScripts;
    for (let i = 0, n = scripts.length; i < n; i++) {
      scripts[i].onStateEnter(this, state, layerIndex);
    }
  }

  private _callAnimatorScriptOnUpdate(state: AnimatorState, layerIndex: number): void {
    const scripts = state._onStateUpdateScripts;
    for (let i = 0, n = scripts.length; i < n; i++) {
      scripts[i].onStateUpdate(this, state, layerIndex);
    }
  }

  private _callAnimatorScriptOnExit(state: AnimatorState, layerIndex: number): void {
    const scripts = state._onStateExitScripts;
    for (let i = 0, n = scripts.length; i < n; i++) {
      scripts[i].onStateExit(this, state, layerIndex);
    }
  }

  private _checkAnyAndEntryState(layerData: AnimatorLayerData, remainDeltaTime: number, aniUpdate: boolean): void {
    const { stateMachine } = layerData.layer;
    const { _anyStateTransitionCollection: anyStateTransitions, _entryTransitionCollection: entryTransitions } =
      stateMachine;
    let transition: AnimatorStateTransition;

    transition =
      anyStateTransitions.count && this._applyTransitionsByCondition(layerData, anyStateTransitions, aniUpdate);

    if (!transition) {
      transition = entryTransitions.count && this._applyTransitionsByCondition(layerData, entryTransitions, aniUpdate);
    }

    if (transition) {
      this._updateState(layerData, remainDeltaTime, aniUpdate);
    } else {
      const defaultState = stateMachine.defaultState;
      if (defaultState) {
        this._preparePlay(defaultState, layerData.layerIndex);
        this._updateState(layerData, remainDeltaTime, aniUpdate);
      }
    }
  }

  private _checkRevertOwner(owner: AnimationCurveOwner<KeyframeValueType>, additive: boolean): void {
    if (additive && owner.updateMark !== this._updateMark) {
      owner.revertDefaultValue();
    }
    owner.updateMark = this._updateMark;
  }

  private _fireAnimationEventsAndCallScripts(
    layerIndex: number,
    playData: AnimatorStatePlayData,
    state: AnimatorState,
    lastClipTime: number,
    lastPlayState: AnimatorStatePlayState,
    deltaTime: number
  ) {
    const { eventHandlers } = playData.stateData;
    eventHandlers.length && this._fireAnimationEvents(playData, eventHandlers, lastClipTime, deltaTime);

    if (lastPlayState === AnimatorStatePlayState.UnStarted) {
      this._callAnimatorScriptOnEnter(state, layerIndex);
    }
    if (lastPlayState !== AnimatorStatePlayState.Finished && playData.playState === AnimatorStatePlayState.Finished) {
      this._callAnimatorScriptOnExit(state, layerIndex);
    } else {
      this._callAnimatorScriptOnUpdate(state, layerIndex);
    }
  }

  private _deactivateTriggeredParameters(): void {
    const passedTriggerParameterNames = Animator._passedTriggerParameterNames;
    for (let i = 0, n = passedTriggerParameterNames.length; i < n; i++) {
      this._parametersValueMap[passedTriggerParameterNames[i]] = false;
    }
  }
}

interface IAnimatorStateInfo {
  layerIndex: number;
  state: AnimatorState;
}
