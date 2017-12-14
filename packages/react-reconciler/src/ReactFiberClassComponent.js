/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';

import {Update} from 'shared/ReactTypeOfSideEffect';
import {
  debugRenderPhaseSideEffects,
  enableAsyncSubtreeAPI,
} from 'shared/ReactFeatureFlags';
import {isMounted} from 'react-reconciler/reflection';
import * as ReactInstanceMap from 'shared/ReactInstanceMap';
import emptyObject from 'fbjs/lib/emptyObject';
import getComponentName from 'shared/getComponentName';
import shallowEqual from 'fbjs/lib/shallowEqual';
import invariant from 'fbjs/lib/invariant';
import warning from 'fbjs/lib/warning';

import {startPhaseTimer, stopPhaseTimer} from './ReactDebugFiberPerf';
import {AsyncUpdates} from './ReactTypeOfInternalContext';
import {
  cacheContext,
  getMaskedContext,
  getUnmaskedContext,
  isContextConsumer,
} from './ReactFiberContext';
import {
  insertUpdateIntoFiber,
  processUpdateQueue,
} from './ReactFiberUpdateQueue';
import {hasContextChanged} from './ReactFiberContext';

const fakeInternalInstance = {};
const isArray = Array.isArray;

let didWarnAboutStateAssignmentForComponent;
let warnOnInvalidCallback;

if (__DEV__) {
  didWarnAboutStateAssignmentForComponent = {};

  warnOnInvalidCallback = function(callback: mixed, callerName: string) {
    warning(
      callback === null || typeof callback === 'function',
      '%s(...): Expected the last optional `callback` argument to be a ' +
        'function. Instead received: %s.',
      callerName,
      callback,
    );
  };

  // This is so gross but it's at least non-critical and can be removed if
  // it causes problems. This is meant to give a nicer error message for
  // ReactDOM15.unstable_renderSubtreeIntoContainer(reactDOM16Component,
  // ...)) which otherwise throws a "_processChildContext is not a function"
  // exception.
  Object.defineProperty(fakeInternalInstance, '_processChildContext', {
    enumerable: false,
    value: function() {
      invariant(
        false,
        '_processChildContext is not available in React 16+. This likely ' +
          'means you have multiple copies of React and are attempting to nest ' +
          'a React 15 tree inside a React 16 tree using ' +
          "unstable_renderSubtreeIntoContainer, which isn't supported. Try " +
          'to make sure you have only one copy of React (and ideally, switch ' +
          'to ReactDOM.createPortal).',
      );
    },
  });
  Object.freeze(fakeInternalInstance);
}

export default function(
  scheduleWork: (fiber: Fiber, expirationTime: ExpirationTime) => void,
  computeExpirationForFiber: (fiber: Fiber) => ExpirationTime,
  memoizeProps: (workInProgress: Fiber, props: any) => void,
  memoizeState: (workInProgress: Fiber, state: any) => void,
) {
  // Class component state updater
  const updater = {
    isMounted,
    enqueueSetState(instance, partialState, callback) {
      const fiber = ReactInstanceMap.get(instance);
      callback = callback === undefined ? null : callback;
      if (__DEV__) {
        warnOnInvalidCallback(callback, 'setState');
      }
      const expirationTime = computeExpirationForFiber(fiber);
      const update = {
        expirationTime,
        partialState,
        callback,
        isReplace: false,
        isForced: false,
        nextCallback: null,
        next: null,
      };
      insertUpdateIntoFiber(fiber, update);
      scheduleWork(fiber, expirationTime);
    },
    enqueueReplaceState(instance, state, callback) {
      const fiber = ReactInstanceMap.get(instance);
      callback = callback === undefined ? null : callback;
      if (__DEV__) {
        warnOnInvalidCallback(callback, 'replaceState');
      }
      const expirationTime = computeExpirationForFiber(fiber);
      const update = {
        expirationTime,
        partialState: state,
        callback,
        isReplace: true,
        isForced: false,
        nextCallback: null,
        next: null,
      };
      insertUpdateIntoFiber(fiber, update);
      scheduleWork(fiber, expirationTime);
    },
    enqueueForceUpdate(instance, callback) {
      const fiber = ReactInstanceMap.get(instance);
      callback = callback === undefined ? null : callback;
      if (__DEV__) {
        warnOnInvalidCallback(callback, 'forceUpdate');
      }
      const expirationTime = computeExpirationForFiber(fiber);
      const update = {
        expirationTime,
        partialState: null,
        callback,
        isReplace: false,
        isForced: true,
        nextCallback: null,
        next: null,
      };
      insertUpdateIntoFiber(fiber, update);
      scheduleWork(fiber, expirationTime);
    },
  };

  // 检查是否经过 ShouldComponentUpdate 生命周期
  function checkShouldComponentUpdate(
    workInProgress,
    oldProps,
    newProps,
    oldState,
    newState,
    newContext,
  ) {
    // 如果 oldProps(this.props) 为 null，则肯定会经过该生命周期（什么时候 this.props 为 null呢）
    // oldState 不会为 null 吗
    // workInProgress 不太清楚具体含义
    if (
      oldProps === null ||
      (workInProgress.updateQueue !== null &&
        workInProgress.updateQueue.hasForceUpdate)
    ) {
      // If the workInProgress already has an Update effect, return true
      return true;
    }

    const instance = workInProgress.stateNode;
    const type = workInProgress.type;
    // 判断是否写了 shouldComponentUpdate 生命周期，不写默认该生命周期返回 true
    if (typeof instance.shouldComponentUpdate === 'function') {
      // dev 环境下调用 timing api，进行性能分析
      startPhaseTimer(workInProgress, 'shouldComponentUpdate');
      // 传入 newProps, newState, newContext(貌似很少用到)
      // https://github.com/facebook/react/issues/2517
      const shouldUpdate = instance.shouldComponentUpdate(
        newProps,
        newState,
        newContext,
      );
      stopPhaseTimer();

      // Simulate an async bailout/interruption by invoking lifecycle twice.
      if (debugRenderPhaseSideEffects) {
        instance.shouldComponentUpdate(newProps, newState, newContext);
      }

      if (__DEV__) {
        // shouldComponentUpdate 未返回 boolean 时进行 warning 提示
        // 为什么判断 不等于 underfined？
        warning(
          shouldUpdate !== undefined,
          '%s.shouldComponentUpdate(): Returned undefined instead of a ' +
            'boolean value. Make sure to return true or false.',
          getComponentName(workInProgress) || 'Unknown',
        );
      }

      return shouldUpdate;
    }

    // 判断该组件是否是 PureComponent
    if (type.prototype && type.prototype.isPureReactComponent) {
      // 当组件为 PureComponent 时对 props 和 state 进行浅比较
      return (
        !shallowEqual(oldProps, newProps) || !shallowEqual(oldState, newState)
      );
    }

    return true;
  }

  // 检查一些 react class 中默认会有的实例
  function checkClassInstance(workInProgress: Fiber) {
    const instance = workInProgress.stateNode;
    const type = workInProgress.type;
    if (__DEV__) {
      const name = getComponentName(workInProgress);
      const renderPresent = instance.render;
      // 如果无法渲染出组件，进行下面的操作
      if (!renderPresent) {
        // 当有 render 函数时，提示可能没有 return 一个 object（virual dom 就是一个 plain old js object）
        if (type.prototype && typeof type.prototype.render === 'function') {
          warning(
            false,
            '%s(...): No `render` method found on the returned component ' +
              'instance: did you accidentally return an object from the constructor?',
            name,
          );
        } else {
          // 否则提示用户是否忘记了些 render 函数。
          warning(
            false,
            '%s(...): No `render` method found on the returned component ' +
              'instance: you may have forgotten to define `render`.',
            name,
          );
        }
      }

      // createClass 时代的一些废弃 api，如果仍旧使用，则报错
      const noGetInitialStateOnES6 =
        !instance.getInitialState ||
        instance.getInitialState.isReactClassApproved ||
        instance.state;
      // react class 组件中写了 getInitialState 方法(为何判断两次)，则提示用户使用 state propperty
      warning(
        noGetInitialStateOnES6,
        'getInitialState was defined on %s, a plain JavaScript class. ' +
          'This is only supported for classes created using React.createClass. ' +
          'Did you mean to define a state property instead?',
        name,
      );
      // react class 组件中写了 getDefaultProps 方法，则提示用户使用 static
      const noGetDefaultPropsOnES6 =
        !instance.getDefaultProps ||
        instance.getDefaultProps.isReactClassApproved;
      warning(
        noGetDefaultPropsOnES6,
        'getDefaultProps was defined on %s, a plain JavaScript class. ' +
          'This is only supported for classes created using React.createClass. ' +
          'Use a static property to define defaultProps instead.',
        name,
      );
      const noInstancePropTypes = !instance.propTypes;
      // React.PropTypes 已经被弃用，如果仍旧使用，进行提示
      warning(
        noInstancePropTypes,
        'propTypes was defined as an instance property on %s. Use a static ' +
          'property to define propTypes instead.',
        name,
      );
      const noInstanceContextTypes = !instance.contextTypes;
      // React.contextTypes 已经被弃用，如果仍旧使用，进行提示
      warning(
        noInstanceContextTypes,
        'contextTypes was defined as an instance property on %s. Use a static ' +
          'property to define contextTypes instead.',
        name,
      );
      const noComponentShouldUpdate =
        typeof instance.componentShouldUpdate !== 'function';
      // shouldComponentUpdate 写成 componentShouldUpdate 时提示
      warning(
        noComponentShouldUpdate,
        '%s has a method called ' +
          'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' +
          'The name is phrased as a question because the function is ' +
          'expected to return a value.',
        name,
      );
      if (
        type.prototype &&
        type.prototype.isPureReactComponent &&
        typeof instance.shouldComponentUpdate !== 'undefined'
      ) {
        // PureComponent 时不能再使用 shouldComponentUpdate，否则提示（坚持使用是否能生效？）
        warning(
          false,
          '%s has a method called shouldComponentUpdate(). ' +
            'shouldComponentUpdate should not be used when extending React.PureComponent. ' +
            'Please extend React.Component if shouldComponentUpdate is used.',
          getComponentName(workInProgress) || 'A pure component',
        );
      }
      const noComponentDidUnmount =
        typeof instance.componentDidUnmount !== 'function';
      // componentWillUnmount 写成了 componentDidUnmount
      warning(
        noComponentDidUnmount,
        '%s has a method called ' +
          'componentDidUnmount(). But there is no such lifecycle method. ' +
          'Did you mean componentWillUnmount()?',
        name,
      );
      const noComponentDidReceiveProps =
        typeof instance.componentDidReceiveProps !== 'function';
      // componentWillReceiveProps 写成 componentDidReceiveProps 
      warning(
        noComponentDidReceiveProps,
        '%s has a method called ' +
          'componentDidReceiveProps(). But there is no such lifecycle method. ' +
          'If you meant to update the state in response to changing props, ' +
          'use componentWillReceiveProps(). If you meant to fetch data or ' +
          'run side-effects or mutations after React has updated the UI, use componentDidUpdate().',
        name,
      );
      const noComponentWillRecieveProps =
        typeof instance.componentWillRecieveProps !== 'function';
      // componentWillReceiveProps 写成了 componentWillRecieveProps
      warning(
        noComponentWillRecieveProps,
        '%s has a method called ' +
          'componentWillRecieveProps(). Did you mean componentWillReceiveProps()?',
        name,
      );
      const hasMutatedProps = instance.props !== workInProgress.pendingProps;
      // super 里的 props 和设置的 props 不一致
      warning(
        instance.props === undefined || !hasMutatedProps,
        '%s(...): When calling super() in `%s`, make sure to pass ' +
          "up the same props that your component's constructor was passed.",
        name,
        name,
      );
      const noInstanceDefaultProps = !instance.defaultProps;
      // 没使用 static defaultProps 而使用了 getDefaultProps 时报错
      warning(
        noInstanceDefaultProps,
        'Setting defaultProps as an instance property on %s is not supported and will be ignored.' +
          ' Instead, define defaultProps as a static property on %s.',
        name,
        name,
      );
    }

    // 下面两个提示 生产环境也会 waring
    const state = instance.state;
    if (state && (typeof state !== 'object' || isArray(state))) {
      // 设置 state 时没有设置成 object 或者 null
      warning(
        false,
        '%s.state: must be set to an object or null',
        getComponentName(workInProgress),
      );
    }
    if (typeof instance.getChildContext === 'function') {
      // 使用 childContextTypes 等时没有 getChildContext
      warning(
        typeof workInProgress.type.childContextTypes === 'object',
        '%s.getChildContext(): childContextTypes must be defined in order to ' +
          'use getChildContext().',
        getComponentName(workInProgress),
      );
    }
  }

  function resetInputPointers(workInProgress: Fiber, instance: any) {
    instance.props = workInProgress.memoizedProps;
    instance.state = workInProgress.memoizedState;
  }

  function adoptClassInstance(workInProgress: Fiber, instance: any): void {
    instance.updater = updater;
    workInProgress.stateNode = instance;
    // The instance needs access to the fiber so that it can schedule updates
    ReactInstanceMap.set(instance, workInProgress);
    if (__DEV__) {
      instance._reactInternalInstance = fakeInternalInstance;
    }
  }

  function constructClassInstance(workInProgress: Fiber, props: any): any {
    const ctor = workInProgress.type;
    const unmaskedContext = getUnmaskedContext(workInProgress);
    const needsContext = isContextConsumer(workInProgress);
    const context = needsContext
      ? getMaskedContext(workInProgress, unmaskedContext)
      : emptyObject;
    const instance = new ctor(props, context);
    adoptClassInstance(workInProgress, instance);

    // Cache unmasked context so we can avoid recreating masked context unless necessary.
    // ReactFiberContext usually updates this cache but can't for newly-created instances.
    if (needsContext) {
      cacheContext(workInProgress, unmaskedContext, context);
    }

    return instance;
  }

  function callComponentWillMount(workInProgress, instance) {
    startPhaseTimer(workInProgress, 'componentWillMount');
    const oldState = instance.state;
    instance.componentWillMount();
    stopPhaseTimer();

    if (oldState !== instance.state) {
      if (__DEV__) {
        warning(
          false,
          '%s.componentWillMount(): Assigning directly to this.state is ' +
            "deprecated (except inside a component's " +
            'constructor). Use setState instead.',
          getComponentName(workInProgress),
        );
      }
      updater.enqueueReplaceState(instance, instance.state, null);
    }
  }

  function callComponentWillReceiveProps(
    workInProgress,
    instance,
    newProps,
    newContext,
  ) {
    startPhaseTimer(workInProgress, 'componentWillReceiveProps');
    const oldState = instance.state;
    instance.componentWillReceiveProps(newProps, newContext);
    stopPhaseTimer();

    // Simulate an async bailout/interruption by invoking lifecycle twice.
    if (debugRenderPhaseSideEffects) {
      instance.componentWillReceiveProps(newProps, newContext);
    }

    if (instance.state !== oldState) {
      if (__DEV__) {
        const componentName = getComponentName(workInProgress) || 'Component';
        if (!didWarnAboutStateAssignmentForComponent[componentName]) {
          warning(
            false,
            '%s.componentWillReceiveProps(): Assigning directly to ' +
              "this.state is deprecated (except inside a component's " +
              'constructor). Use setState instead.',
            componentName,
          );
          didWarnAboutStateAssignmentForComponent[componentName] = true;
        }
      }
      updater.enqueueReplaceState(instance, instance.state, null);
    }
  }

  // Invokes the mount life-cycles on a previously never rendered instance.
  function mountClassInstance(
    workInProgress: Fiber,
    renderExpirationTime: ExpirationTime,
  ): void {
    const current = workInProgress.alternate;

    if (__DEV__) {
      checkClassInstance(workInProgress);
    }

    const instance = workInProgress.stateNode;
    const state = instance.state || null;
    const props = workInProgress.pendingProps;
    const unmaskedContext = getUnmaskedContext(workInProgress);

    instance.props = props;
    instance.state = workInProgress.memoizedState = state;
    instance.refs = emptyObject;
    instance.context = getMaskedContext(workInProgress, unmaskedContext);

    if (
      enableAsyncSubtreeAPI &&
      workInProgress.type != null &&
      workInProgress.type.prototype != null &&
      workInProgress.type.prototype.unstable_isAsyncReactComponent === true
    ) {
      workInProgress.internalContextTag |= AsyncUpdates;
    }

    if (typeof instance.componentWillMount === 'function') {
      callComponentWillMount(workInProgress, instance);
      // If we had additional state updates during this life-cycle, let's
      // process them now.
      const updateQueue = workInProgress.updateQueue;
      if (updateQueue !== null) {
        instance.state = processUpdateQueue(
          current,
          workInProgress,
          updateQueue,
          instance,
          props,
          renderExpirationTime,
        );
      }
    }
    if (typeof instance.componentDidMount === 'function') {
      workInProgress.effectTag |= Update;
    }
  }

  // Called on a preexisting class instance. Returns false if a resumed render
  // could be reused.
  // function resumeMountClassInstance(
  //   workInProgress: Fiber,
  //   priorityLevel: PriorityLevel,
  // ): boolean {
  //   const instance = workInProgress.stateNode;
  //   resetInputPointers(workInProgress, instance);

  //   let newState = workInProgress.memoizedState;
  //   let newProps = workInProgress.pendingProps;
  //   if (!newProps) {
  //     // If there isn't any new props, then we'll reuse the memoized props.
  //     // This could be from already completed work.
  //     newProps = workInProgress.memoizedProps;
  //     invariant(
  //       newProps != null,
  //       'There should always be pending or memoized props. This error is ' +
  //         'likely caused by a bug in React. Please file an issue.',
  //     );
  //   }
  //   const newUnmaskedContext = getUnmaskedContext(workInProgress);
  //   const newContext = getMaskedContext(workInProgress, newUnmaskedContext);

  //   const oldContext = instance.context;
  //   const oldProps = workInProgress.memoizedProps;

  //   if (
  //     typeof instance.componentWillReceiveProps === 'function' &&
  //     (oldProps !== newProps || oldContext !== newContext)
  //   ) {
  //     callComponentWillReceiveProps(
  //       workInProgress,
  //       instance,
  //       newProps,
  //       newContext,
  //     );
  //   }

  //   // Process the update queue before calling shouldComponentUpdate
  //   const updateQueue = workInProgress.updateQueue;
  //   if (updateQueue !== null) {
  //     newState = processUpdateQueue(
  //       workInProgress,
  //       updateQueue,
  //       instance,
  //       newState,
  //       newProps,
  //       priorityLevel,
  //     );
  //   }

  //   // TODO: Should we deal with a setState that happened after the last
  //   // componentWillMount and before this componentWillMount? Probably
  //   // unsupported anyway.

  //   if (
  //     !checkShouldComponentUpdate(
  //       workInProgress,
  //       workInProgress.memoizedProps,
  //       newProps,
  //       workInProgress.memoizedState,
  //       newState,
  //       newContext,
  //     )
  //   ) {
  //     // Update the existing instance's state, props, and context pointers even
  //     // though we're bailing out.
  //     instance.props = newProps;
  //     instance.state = newState;
  //     instance.context = newContext;
  //     return false;
  //   }

  //   // Update the input pointers now so that they are correct when we call
  //   // componentWillMount
  //   instance.props = newProps;
  //   instance.state = newState;
  //   instance.context = newContext;

  //   if (typeof instance.componentWillMount === 'function') {
  //     callComponentWillMount(workInProgress, instance);
  //     // componentWillMount may have called setState. Process the update queue.
  //     const newUpdateQueue = workInProgress.updateQueue;
  //     if (newUpdateQueue !== null) {
  //       newState = processUpdateQueue(
  //         workInProgress,
  //         newUpdateQueue,
  //         instance,
  //         newState,
  //         newProps,
  //         priorityLevel,
  //       );
  //     }
  //   }

  //   if (typeof instance.componentDidMount === 'function') {
  //     workInProgress.effectTag |= Update;
  //   }

  //   instance.state = newState;

  //   return true;
  // }

  // Invokes the update life-cycles and returns false if it shouldn't rerender.
  function updateClassInstance(
    current: Fiber,
    workInProgress: Fiber,
    renderExpirationTime: ExpirationTime,
  ): boolean {
    const instance = workInProgress.stateNode;
    resetInputPointers(workInProgress, instance);

    const oldProps = workInProgress.memoizedProps;
    const newProps = workInProgress.pendingProps;
    const oldContext = instance.context;
    const newUnmaskedContext = getUnmaskedContext(workInProgress);
    const newContext = getMaskedContext(workInProgress, newUnmaskedContext);

    // Note: During these life-cycles, instance.props/instance.state are what
    // ever the previously attempted to render - not the "current". However,
    // during componentDidUpdate we pass the "current" props.

    if (
      typeof instance.componentWillReceiveProps === 'function' &&
      (oldProps !== newProps || oldContext !== newContext)
    ) {
      callComponentWillReceiveProps(
        workInProgress,
        instance,
        newProps,
        newContext,
      );
    }

    // Compute the next state using the memoized state and the update queue.
    const oldState = workInProgress.memoizedState;
    // TODO: Previous state can be null.
    let newState;
    if (workInProgress.updateQueue !== null) {
      newState = processUpdateQueue(
        current,
        workInProgress,
        workInProgress.updateQueue,
        instance,
        newProps,
        renderExpirationTime,
      );
    } else {
      newState = oldState;
    }

    if (
      oldProps === newProps &&
      oldState === newState &&
      !hasContextChanged() &&
      !(
        workInProgress.updateQueue !== null &&
        workInProgress.updateQueue.hasForceUpdate
      )
    ) {
      // If an update was already in progress, we should schedule an Update
      // effect even though we're bailing out, so that cWU/cDU are called.
      if (typeof instance.componentDidUpdate === 'function') {
        if (
          oldProps !== current.memoizedProps ||
          oldState !== current.memoizedState
        ) {
          workInProgress.effectTag |= Update;
        }
      }
      return false;
    }

    const shouldUpdate = checkShouldComponentUpdate(
      workInProgress,
      oldProps,
      newProps,
      oldState,
      newState,
      newContext,
    );

    if (shouldUpdate) {
      if (typeof instance.componentWillUpdate === 'function') {
        startPhaseTimer(workInProgress, 'componentWillUpdate');
        instance.componentWillUpdate(newProps, newState, newContext);
        stopPhaseTimer();

        // Simulate an async bailout/interruption by invoking lifecycle twice.
        if (debugRenderPhaseSideEffects) {
          instance.componentWillUpdate(newProps, newState, newContext);
        }
      }
      if (typeof instance.componentDidUpdate === 'function') {
        workInProgress.effectTag |= Update;
      }
    } else {
      // If an update was already in progress, we should schedule an Update
      // effect even though we're bailing out, so that cWU/cDU are called.
      if (typeof instance.componentDidUpdate === 'function') {
        if (
          oldProps !== current.memoizedProps ||
          oldState !== current.memoizedState
        ) {
          workInProgress.effectTag |= Update;
        }
      }

      // If shouldComponentUpdate returned false, we should still update the
      // memoized props/state to indicate that this work can be reused.
      memoizeProps(workInProgress, newProps);
      memoizeState(workInProgress, newState);
    }

    // Update the existing instance's state, props, and context pointers even
    // if shouldComponentUpdate returns false.
    instance.props = newProps;
    instance.state = newState;
    instance.context = newContext;

    return shouldUpdate;
  }

  return {
    adoptClassInstance,
    constructClassInstance,
    mountClassInstance,
    // resumeMountClassInstance,
    updateClassInstance,
  };
}
