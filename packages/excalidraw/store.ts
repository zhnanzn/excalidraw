import { ENV } from "./constants";
import { Emitter } from "./emitter";
import { randomId } from "./random";
import { isShallowEqual } from "./utils";
import { getDefaultAppState } from "./appState";
import { AppStateDelta, ElementsDelta } from "./delta";
import { newElementWith } from "./element/mutateElement";
import { deepCopyElement } from "./element/newElement";
import type { AppState, ObservedAppState } from "./types";
import type { DTO, ValueOf } from "./utility-types";
import type {
  OrderedExcalidrawElement,
  SceneElementsMap,
} from "./element/types";

// hidden non-enumerable property for runtime checks
const hiddenObservedAppStateProp = "__observedAppState";

export const getObservedAppState = (appState: AppState): ObservedAppState => {
  const observedAppState = {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElementId: appState.editingLinearElement?.elementId || null,
    selectedLinearElementId: appState.selectedLinearElement?.elementId || null,
    croppingElementId: appState.croppingElementId,
  };

  Reflect.defineProperty(observedAppState, hiddenObservedAppStateProp, {
    value: true,
    enumerable: false,
  });

  return observedAppState;
};

const isObservedAppState = (
  appState: AppState | ObservedAppState,
): appState is ObservedAppState =>
  !!Reflect.get(appState, hiddenObservedAppStateProp);

// CFDO: consider adding a "remote" action, which should perform update but never be emitted (so that it we don't have to filter it for pushing it into sync api)
export const StoreAction = {
  /**
   * Immediately undoable.
   *
   * Use for updates which should produce recorded deltas.
   * Should be used for most of the local updates (except ephemerals such as dragging or resizing).
   *
   * These updates will _immediately_ make it to the local undo / redo stacks.
   */
  RECORD: "record",
  /**
   * Never undoable.
   *
   * Use for updates which should never be recorded, such as remote updates
   * or scene initialization.
   *
   * These updates will _never_ make it to the local undo / redo stacks.
   */
  UPDATE: "update",
  /**
   * Eventually undoable.
   *
   * Use for updates which should not be recorded immediately, such as
   * exceptions which are part of some async multi-step process.
   *
   * These updates will be recorded with the next `StoreAction.RECORD`,
   * triggered either by the next `updateScene` or internally by the editor.
   *
   * These updates will _eventually_ make it to the local undo / redo stacks.
   */
  NONE: "none",
} as const;

export type StoreActionType = ValueOf<typeof StoreAction>;

/**
 * Store which records the observed changes and emits them as `StoreIncrement` events.
 */
export class Store {
  public readonly onStoreIncrementEmitter = new Emitter<
    [DurableStoreIncrement | EphemeralStoreIncrement]
  >();

  private _snapshot = StoreSnapshot.empty();

  public get snapshot() {
    return this._snapshot;
  }

  public set snapshot(snapshot: StoreSnapshot) {
    this._snapshot = snapshot;
  }

  private scheduledActions: Set<StoreActionType> = new Set();

  private get shouldRecordDelta() {
    return this.scheduledActions.has(StoreAction.RECORD);
  }

  private get shouldUpdateSnapshot() {
    return this.scheduledActions.has(StoreAction.UPDATE);
  }

  /**
   * Use to schedule a delta calculation, which will consquentially be emitted as `DurableStoreIncrement` and recorded in the undo stack.
   */
  // TODO: Suspicious that this is called so many places. Seems error-prone.
  public scheduleRecording() {
    this.scheduleAction(StoreAction.RECORD);
  }

  /**
   * Use to schedule update of the snapshot, useful on updates for which we don't need to calculate deltas (i.e. remote updates).
   */
  public scheduleUpdate() {
    this.scheduleAction(StoreAction.UPDATE);
  }

  private scheduleAction(action: StoreActionType) {
    this.scheduledActions.add(action);
    this.satisfiesScheduledActionsInvariant();
  }

  /**
   * Based on the scheduled operation, either only updates store snapshot or also calculates delta and emits the result as a `StoreIncrement`, which gets recorded in the undo stack.
   *
   * @emits StoreIncrement
   */
  public commit(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
  ): void {
    try {
      // Recording has a precedence since it also performs snapshot update, but emits a durable increment
      if (this.shouldRecordDelta) {
        this.recordDurableIncrement(elements, appState);
        return;
      }

      const nextSnapshot = this.produceEphemeralIncrement(elements, appState);
      if (nextSnapshot && this.shouldUpdateSnapshot) {
        this.snapshot = nextSnapshot;
      }
    } finally {
      this.satisfiesScheduledActionsInvariant();
      // Defensively reset all scheduled actions, potentially cleans up other runtime garbage
      this.scheduledActions = new Set();
    }
  }

  /**
   * Performs delta calculation and emits the increment.
   *
   * @emits StoreIncrement.
   */
  public recordDurableIncrement(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
  ) {
    const prevSnapshot = this.snapshot;
    const nextSnapshot = this.snapshot.maybeClone(elements, appState);

    // Optimisation, don't continue if nothing has changed
    if (prevSnapshot !== nextSnapshot) {
      // Calculate the deltas based on the previous and next snapshot
      const elementsDelta = nextSnapshot.metadata.didElementsChange
        ? ElementsDelta.calculate(prevSnapshot.elements, nextSnapshot.elements)
        : ElementsDelta.empty();

      const appStateDelta = nextSnapshot.metadata.didAppStateChange
        ? AppStateDelta.calculate(prevSnapshot.appState, nextSnapshot.appState)
        : AppStateDelta.empty();

      if (!elementsDelta.isEmpty() || !appStateDelta.isEmpty()) {
        const delta = StoreDelta.create(elementsDelta, appStateDelta);
        const change = StoreChange.create(prevSnapshot, nextSnapshot);
        const increment = new DurableStoreIncrement(change, delta);

        // Notify listeners with the increment
        this.onStoreIncrementEmitter.trigger(increment);
      }

      // Update snapshot
      this.snapshot = nextSnapshot;
    }
  }

  /**
   * When change is detected, emits an ephemeral increment and returns the next snapshot.
   *
   * @emits EphemeralStoreIncrement
   */
  public produceEphemeralIncrement(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
  ) {
    const prevSnapshot = this.snapshot;
    const nextSnapshot = this.snapshot.maybeClone(elements, appState);

    if (prevSnapshot === nextSnapshot) {
      // nothing has changed
      return;
    }

    const change = StoreChange.create(prevSnapshot, nextSnapshot);
    const increment = new EphemeralStoreIncrement(change);

    // Notify listeners with the increment
    this.onStoreIncrementEmitter.trigger(increment);

    return nextSnapshot;
  }

  /**
   * Filters out yet uncomitted elements from `nextElements`, which are part of in-progress local async actions (ephemerals) and thus were not yet commited to the snapshot.
   *
   * This is necessary in updates in which we receive reconciled elements, already containing elements which were not yet recorded by the local store (i.e. collab).
   */
  public filterUncomittedElements(
    prevElements: Map<string, OrderedExcalidrawElement>,
    nextElements: Map<string, OrderedExcalidrawElement>,
  ) {
    for (const [id, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(id);

      if (!nextElement) {
        // Nothing to care about here, elements were forcefully deleted
        continue;
      }

      const elementSnapshot = this.snapshot.elements.get(id);

      // Checks for in progress async user action
      if (!elementSnapshot) {
        // Detected yet uncomitted local element
        nextElements.delete(id);
      } else if (elementSnapshot.version < prevElement.version) {
        // Element was already commited, but the snapshot version is lower than current current local version
        nextElements.set(id, elementSnapshot);
      }
    }

    return nextElements;
  }

  /**
   * Apply and emit increment.
   *
   * @emits StoreIncrement when increment is applied.
   */
  public applyDeltaTo(
    delta: StoreDelta,
    elements: SceneElementsMap,
    appState: AppState,
  ): [SceneElementsMap, AppState, boolean] {
    const [nextElements, elementsContainVisibleChange] = delta.elements.applyTo(
      elements,
      this.snapshot.elements,
    );

    const [nextAppState, appStateContainsVisibleChange] =
      delta.appState.applyTo(appState, nextElements);

    const appliedVisibleChanges =
      elementsContainVisibleChange || appStateContainsVisibleChange;

    const prevSnapshot = this.snapshot;
    const nextSnapshot = this.snapshot.maybeClone(nextElements, nextAppState);

    const change = StoreChange.create(prevSnapshot, nextSnapshot);
    const increment = new DurableStoreIncrement(change, delta);

    this.onStoreIncrementEmitter.trigger(increment);

    return [nextElements, nextAppState, appliedVisibleChanges];
  }

  /**
   * Clears the store instance.
   */
  public clear(): void {
    this.snapshot = StoreSnapshot.empty();
    this.scheduledActions = new Set();
  }

  private satisfiesScheduledActionsInvariant() {
    if (!(this.scheduledActions.size >= 0 && this.scheduledActions.size <= 3)) {
      const message = `There can be at most three store actions scheduled at the same time, but there are "${this.scheduledActions.size}".`;
      console.error(message, this.scheduledActions.values());

      if (import.meta.env.DEV || import.meta.env.MODE === ENV.TEST) {
        throw new Error(message);
      }
    }
  }
}

/**
 * Repsents a change to the store containg changed elements and appState.
 */
class StoreChange {
  private constructor(
    public readonly elements: Map<string, OrderedExcalidrawElement>,
    public readonly appState: AppState,
  ) {}

  public static create(
    prevSnapshot: StoreSnapshot,
    nextSnapshot: StoreSnapshot,
  ) {
    const changedElements = prevSnapshot.getChangedElements(nextSnapshot);

    // CFDO: temporary appState
    return new StoreChange(changedElements, getDefaultAppState() as AppState);
  }
}

/**
 * Encpasulates any change to the store (durable or ephemeral).
 */
export abstract class StoreIncrement {
  protected constructor(
    public readonly type: "durable" | "ephemeral",
    public readonly change: StoreChange,
  ) {}

  public static isDurable(
    increment: StoreIncrement,
  ): increment is DurableStoreIncrement {
    return increment.type === "durable";
  }

  public static isEphemeral(
    increment: StoreIncrement,
  ): increment is EphemeralStoreIncrement {
    return increment.type === "ephemeral";
  }
}

/**
 * Represents a durable change to the store.
 */
export class DurableStoreIncrement extends StoreIncrement {
  constructor(
    public readonly change: StoreChange,
    public readonly delta: StoreDelta,
  ) {
    super("durable", change);
  }
}

/**
 * Represents an ephemeral change to the store.
 */
export class EphemeralStoreIncrement extends StoreIncrement {
  constructor(public readonly change: StoreChange) {
    super("ephemeral", change);
  }
}

/**
 * Represents a recored delta by the Store.
 */
export class StoreDelta {
  private constructor(
    public readonly id: string,
    public readonly elements: ElementsDelta,
    public readonly appState: AppStateDelta,
  ) {}

  /**
   * Create a new instance of `StoreDelta`.
   */
  public static create(
    elements: ElementsDelta,
    appState: AppStateDelta,
    opts: {
      id: string;
    } = {
      id: randomId(),
    },
  ) {
    return new StoreDelta(opts.id, elements, appState);
  }

  /**
   * Restore a store delta instance from a DTO.
   */
  public static restore(storeDeltaDTO: DTO<StoreDelta>) {
    const { id, elements, appState } = storeDeltaDTO;
    return new StoreDelta(
      id,
      ElementsDelta.restore(elements),
      AppStateDelta.restore(appState),
    );
  }

  /**
   * Parse and load the delta from the remote payload.
   */
  // CFDO: why it would be a string if it can be a DTO?
  public static load(payload: string) {
    // CFDO: ensure typesafety
    const {
      id,
      elements: { added, removed, updated },
    } = JSON.parse(payload);

    const elements = ElementsDelta.create(added, removed, updated, {
      shouldRedistribute: false,
    });

    return new StoreDelta(id, elements, AppStateDelta.empty());
  }

  /**
   * Inverse store delta, creates new instance of `StoreDelta`.
   */
  public inverse(): StoreDelta {
    return new StoreDelta(
      randomId(),
      this.elements.inverse(),
      this.appState.inverse(),
    );
  }

  /**
   * Apply latest (remote) changes to the delta, creates new instance of `StoreDelta`.
   */
  public applyLatestChanges(elements: SceneElementsMap): StoreDelta {
    const inversedDelta = this.inverse();

    return new StoreDelta(
      inversedDelta.id,
      inversedDelta.elements.applyLatestChanges(elements),
      inversedDelta.appState,
    );
  }

  public isEmpty() {
    return this.elements.isEmpty() && this.appState.isEmpty();
  }
}

/**
 * Represents a snapshot of the recorded changes to the store,
 * used for producing deltas and emitting `DurableStoreIncrement`s.
 */
export class StoreSnapshot {
  private constructor(
    public readonly elements: Map<string, OrderedExcalidrawElement>,
    public readonly appState: ObservedAppState,
    public readonly metadata: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      isEmpty?: boolean;
    } = {
      didElementsChange: false,
      didAppStateChange: false,
      isEmpty: false,
    },
  ) {}

  public static empty() {
    return new StoreSnapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
      { didElementsChange: false, didAppStateChange: false, isEmpty: true },
    );
  }

  public getChangedElements(prevSnapshot: StoreSnapshot) {
    const changedElements = new Map<string, OrderedExcalidrawElement>();

    for (const [id, nextElement] of this.elements.entries()) {
      // due to the structural clone inside `maybeClone`, we can perform just these reference checks
      if (prevSnapshot.elements.get(id) !== nextElement) {
        changedElements.set(id, nextElement);
      }
    }

    return changedElements;
  }

  public isEmpty() {
    return this.metadata.isEmpty;
  }

  /**
   * Efficiently clone the existing snapshot, only if we detected changes.
   *
   * @returns same instance if there are no changes detected, new instance otherwise.
   */
  public maybeClone(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
  ) {
    const nextElementsSnapshot = this.maybeCreateElementsSnapshot(elements);
    const nextAppStateSnapshot = this.maybeCreateAppStateSnapshot(appState);

    let didElementsChange = false;
    let didAppStateChange = false;

    if (this.elements !== nextElementsSnapshot) {
      didElementsChange = true;
    }

    if (this.appState !== nextAppStateSnapshot) {
      didAppStateChange = true;
    }

    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    const snapshot = new StoreSnapshot(
      nextElementsSnapshot,
      nextAppStateSnapshot,
      {
        didElementsChange,
        didAppStateChange,
      },
    );

    return snapshot;
  }

  private maybeCreateAppStateSnapshot(
    appState: AppState | ObservedAppState | undefined,
  ) {
    if (!appState) {
      return this.appState;
    }

    // Not watching over everything from the app state, just the relevant props
    const nextAppStateSnapshot = !isObservedAppState(appState)
      ? getObservedAppState(appState)
      : appState;

    const didAppStateChange = this.detectChangedAppState(nextAppStateSnapshot);

    if (!didAppStateChange) {
      return this.appState;
    }

    return nextAppStateSnapshot;
  }

  private detectChangedAppState(nextObservedAppState: ObservedAppState) {
    return !isShallowEqual(this.appState, nextObservedAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  private maybeCreateElementsSnapshot(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
  ) {
    if (!elements) {
      return this.elements;
    }

    const didElementsChange = this.detectChangedElements(elements);

    if (!didElementsChange) {
      return this.elements;
    }

    const elementsSnapshot = this.createElementsSnapshot(elements);
    return elementsSnapshot;
  }

  /**
   * Detect if there any changed elements.
   *
   * NOTE: we shouldn't just use `sceneVersionNonce` instead, as we need to call this before the scene updates.
   */
  private detectChangedElements(
    nextElements: Map<string, OrderedExcalidrawElement>,
  ) {
    if (this.elements === nextElements) {
      return false;
    }

    if (this.elements.size !== nextElements.size) {
      return true;
    }

    // loop from right to left as changes are likelier to happen on new elements
    const keys = Array.from(nextElements.keys());

    for (let i = keys.length - 1; i >= 0; i--) {
      const prev = this.elements.get(keys[i]);
      const next = nextElements.get(keys[i]);
      if (
        !prev ||
        !next ||
        prev.id !== next.id ||
        prev.version !== next.version ||
        prev.versionNonce !== next.versionNonce
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Perform structural clone, deep cloning only elements that changed.
   */
  private createElementsSnapshot(
    nextElements: Map<string, OrderedExcalidrawElement>,
  ) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements.entries()) {
      // Clone previous elements, never delete, in case nextElements would be just a subset of previous elements
      // i.e. during collab, persist or whenenever isDeleted elements get cleared
      if (!nextElements.get(id)) {
        // When we cannot find the prev element in the next elements, we mark it as deleted
        clonedElements.set(
          id,
          deepCopyElement(newElementWith(prevElement, { isDeleted: true })),
        );
      } else {
        clonedElements.set(id, prevElement);
      }
    }

    for (const [id, nextElement] of nextElements.entries()) {
      const prevElement = clonedElements.get(id);

      // At this point our elements are reconcilled already, meaning the next element is always newer
      if (
        !prevElement || // element was added
        (prevElement && prevElement.versionNonce !== nextElement.versionNonce) // element was updated
      ) {
        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}
