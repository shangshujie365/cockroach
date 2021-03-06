/**
 * This module maintains the state of read-only data fetched from the cluster.
 * Data is fetched from an API endpoint in either 'util/api' or
 * 'util/cockroachlabsAPI'
 */

import * as _ from "lodash";
import { Dispatch } from "redux";
import { assert } from "chai";
import moment = require("moment");

import { APIRequestFn } from "../util/api.ts";

import { Action, PayloadAction, WithRequest } from "../interfaces/action";

// CachedDataReducerState is used to track the state of the cached data.
export class CachedDataReducerState<TResponseMessage> {
  data: TResponseMessage; // the latest data received
  inFlight = false; // true if a request is in flight
  valid = false; // true if data has been received and has not been invalidated
  lastError: Error; // populated with the most recent error, if the last request failed
}

// KeyedCachedDataReducerState is used to track the state of the cached data
// that is associated with a key.
export class KeyedCachedDataReducerState<TResponseMessage> {
  [id: string]: CachedDataReducerState<TResponseMessage>;
}

/**
 * CachedDataReducer is a wrapper object that contains a redux reducer and a
 * number of redux actions. The reducer method is the reducer and the refresh
 * method is the main action creator that refreshes the data when dispatched.
 *
 * Each instance of this class is instantiated with an api endpoint with request
 * type TRequest and response type Promise<TResponseMessage>.
 */
export class CachedDataReducer<TRequest, TResponseMessage> {
  // Track all the currently seen namespaces, to ensure there isn't a conflict
  private static namespaces: { [actionNamespace: string]: boolean } = {};

  // Actions
  REQUEST: string; // make a new request
  RECEIVE: string; // receive new data
  ERROR: string; // request encountered an error
  INVALIDATE: string; // invalidate data

  /**
   * apiEndpoint - The API endpoint used to refresh data.
   * actionNamespace - A unique namespace for the redux actions.
   * invalidationPeriod (optional) - The duration after
   *   data is received after which it will be invalidated.
   */
  constructor(protected apiEndpoint: APIRequestFn<TRequest, TResponseMessage>, public actionNamespace: string, protected invalidationPeriod?: moment.Duration) {
    // check actionNamespace
    assert.notProperty(CachedDataReducer.namespaces, actionNamespace, "Expected actionNamespace to be unique.");
    CachedDataReducer.namespaces[actionNamespace] = true;

    this.REQUEST = `cockroachui/CachedDataReducer/${actionNamespace}/REQUEST`;
    this.RECEIVE = `cockroachui/CachedDataReducer/${actionNamespace}/RECEIVE`;
    this.ERROR = `cockroachui/CachedDataReducer/${actionNamespace}/ERROR`;
    this.INVALIDATE = `cockroachui/CachedDataReducer/${actionNamespace}/INVALIDATE`;
  }

  /**
   * Redux reducer which processes actions related to the api endpoint query.
   */
  reducer = (state = new CachedDataReducerState<TResponseMessage>(), action: Action): CachedDataReducerState<TResponseMessage> => {
    switch (action.type) {
      case this.REQUEST:
        // A request is in progress.
        state = _.clone(state);
        state.inFlight = true;
        return state;
      case this.RECEIVE:
        // The results of a request have been received.
        const { payload } = action as PayloadAction<WithRequest<TResponseMessage, TRequest>>;
        state = _.clone(state);
        state.inFlight = false;
        state.data = payload.data;
        state.valid = true;
        state.lastError = null;
        return state;
      case this.ERROR:
        // A request failed.
        let { payload: error } = action as PayloadAction<WithRequest<Error, TRequest>>;
        state = _.clone(state);
        state.inFlight = false;
        state.lastError = error.data;
        state.valid = false;
        return state;
      case this.INVALIDATE:
        // The data is invalidated.
        state = _.clone(state);
        state.valid = false;
        return state;
      default:
        return state;
    }
  }

  // requestData is the REQUEST action creator.
  requestData = (request?: TRequest): PayloadAction<WithRequest<void, TRequest>> => {
    return {
      type: this.REQUEST,
      payload: { request },
    };
  }

  // receiveData is the RECEIVE action creator.
  receiveData = (data: TResponseMessage, request?: TRequest): PayloadAction<WithRequest<TResponseMessage, TRequest>> => {
    return {
      type: this.RECEIVE,
      payload: { request, data },
    };
  }

  // errorData is the ERROR action creator.
  errorData = (error: Error, request?: TRequest): PayloadAction<WithRequest<Error, TRequest>> => {
    return {
      type: this.ERROR,
      payload: { request, data: error },
    };
  }

  // invalidateData is the INVALIDATE action creator.
  invalidateData = (request?: TRequest): PayloadAction<WithRequest<void, TRequest>> => {
    return {
      type: this.INVALIDATE,
      payload: { request },
    };
  }

  /**
   * refresh is the primary action creator that should be used to refresh the
   * cached data. Dispatching it will attempt to asynchronously refresh the
   * cached data if and only if:
   * - a request is not in flight AND
   *   - its results are not considered valid OR
   *   - it has no invalidation period
   *
   * req - the request associated with this call to refresh. It includes any
   *   parameters passed to the API call.
   * stateAccessor (optional) - a helper function that accesses this reducer's
   *   state given the global state object
   */
  refresh = <S>(req?: TRequest, stateAccessor = (state: any, r: TRequest) => state.cachedData[this.actionNamespace]) => {
    return (dispatch: Dispatch<S>, getState: () => any) => {
      let state: CachedDataReducerState<TResponseMessage> = stateAccessor(getState(), req);

      if (state && (state.inFlight || (this.invalidationPeriod && state.valid))) {
        return;
      }

      // Note that after dispatching requestData, state.inFlight is true
      dispatch(this.requestData(req));
      // Fetch data from the servers. Return the promise for use in tests.
      return this.apiEndpoint(req, this.invalidationPeriod).then((data) => {
        // Dispatch the results to the store.
        dispatch(this.receiveData(data, req));
      }).catch((error: Error) => {
        // If an error occurred during the fetch, add it to the store.
        // Wait 1s to record the error to avoid spamming errors.
        // TODO(maxlang): Fix error handling more comprehensively.
        // Tracked in #8699
        setTimeout(() => dispatch(this.errorData(error, req)), 1000);
      }).then(() => {
        // Invalidate data after the invalidation period if one exists.
        if (this.invalidationPeriod) {
          setTimeout(() => dispatch(this.invalidateData(req)), this.invalidationPeriod.asMilliseconds());
        }
      });
    };
  }
}

/**
 * KeyedCachedDataReducer is a wrapper object that contains a redux reducer and
 * an instance of CachedDataReducer. The reducer method is the reducer and the
 * refresh method is the main action creator that refreshes the data when
 * dispatched. All action creators and the basic reducer are from the
 * CachedDataReducer instance.
 *
 * Each instance of this class is instantiated with an api endpoint with request
 * type TRequest and response type Promise<TResponseMessage>.
 */
export class KeyedCachedDataReducer<TRequest, TResponseMessage> {
  cachedDataReducer: CachedDataReducer<TRequest, TResponseMessage>;

  /**
   * apiEndpoint - The API endpoint used to refresh data.
   * actionNamespace - A unique namespace for the redux actions.
   * requestToID - A function that takes a TRequest and returns a string. Used
   *   as a key to store data returned from that request
   * invalidationPeriod (optional) - The duration after
   *   data is received after which it will be invalidated.
   *
   * apiEndpoint, actionNamespace, and invalidationPeriod are all passed
   * to the CachedDataReducer constructor
   */
  constructor(protected apiEndpoint: (req: TRequest) => Promise<TResponseMessage>, public actionNamespace: string, private requestToID: (req: TRequest) => string, protected invalidationPeriod?: moment.Duration) {
    this.cachedDataReducer = new CachedDataReducer<TRequest, TResponseMessage>(apiEndpoint, actionNamespace, invalidationPeriod);
  }

  /**
   * refresh calls the internal CachedDataReducer's refresh function using a
   * default stateAccessor that indexes in to the state based on a key generated
   * from the request.
   */
  refresh = (req?: TRequest, stateAccessor = (state: any, r: TRequest) => state.cachedData[this.cachedDataReducer.actionNamespace][this.requestToID(r)]) => this.cachedDataReducer.refresh(req, stateAccessor);

  /**
   * Keyed redux reducer which pulls out the id from the action payload and then
   * runs the CachedDataReducer reducer on the action.
   */
  reducer = (state = new KeyedCachedDataReducerState<TResponseMessage>(), action: Action): KeyedCachedDataReducerState<TResponseMessage> => {
    switch (action.type) {
      case this.cachedDataReducer.REQUEST:
      case this.cachedDataReducer.RECEIVE:
      case this.cachedDataReducer.ERROR:
      case this.cachedDataReducer.INVALIDATE:
        let { request } = (action as PayloadAction<WithRequest<TResponseMessage | Error | void, TRequest>>).payload;
        let id = this.requestToID(request);
        state = _.clone(state);
        state[id] = this.cachedDataReducer.reducer(state[id], action);
        return state;
      default:
        return state;
    }
  }
}
