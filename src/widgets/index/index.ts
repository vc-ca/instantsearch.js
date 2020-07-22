import algoliasearchHelper, {
  AlgoliaSearchHelper as Helper,
  DerivedHelper,
  PlainSearchParameters,
  SearchParameters,
  SearchResults,
  AlgoliaSearchHelper,
} from 'algoliasearch-helper';
import {
  InstantSearch,
  UiState,
  IndexUiState,
  Widget,
  InitOptions,
  RenderOptions,
  WidgetUiStateOptions,
  WidgetSearchParametersOptions,
  ScopedResult,
  SearchClient,
} from '../../types';
import {
  checkIndexUiState,
  createDocumentationMessageGenerator,
  resolveSearchParameters,
  mergeSearchParameters,
  warning,
} from '../../lib/utils';

import { WidgetType, WidgetParams, Schema } from '../../../schema';

function Pbf() {
  this.buf = new Uint8Array(0);
  this.pos = 0;
  this.type = 0;
  this.length = 0;
}

Pbf.prototype = {
  finish() {
    this.length = this.pos;
    this.pos = 0;
    return this.buf.subarray(0, this.length);
  },

  writeVarint(val) {
    val = +val || 0;

    if (val > 0xfffffff || val < 0) throw new Error('Unsupported');

    // realloc
    let length = this.length || 16;
    while (length < this.pos + 4) length *= 2;
    if (length !== this.length) {
      const buf = new Uint8Array(length);
      buf.set(this.buf);
      this.buf = buf;
      this.length = length;
    }

    this.buf[this.pos++] = (val & 0x7f) | (val > 0x7f ? 0x80 : 0);
    if (val <= 0x7f) return;
    this.buf[this.pos++] = ((val >>>= 7) & 0x7f) | (val > 0x7f ? 0x80 : 0);
    if (val <= 0x7f) return;
    this.buf[this.pos++] = ((val >>>= 7) & 0x7f) | (val > 0x7f ? 0x80 : 0);
    if (val <= 0x7f) return;
    this.buf[this.pos++] = (val >>> 7) & 0x7f;
  },

  writeMessage(tag, fn, obj) {
    this.writeVarint((tag << 3) | 2);

    this.pos++; // reserve 1 byte for short message length

    // write the message directly to the buffer and see how much was written
    const startPos = this.pos;
    fn(obj, this);
    const len = this.pos - startPos;

    if (len >= 0x80) throw new Error('Unsupported');

    // finally, write the message length in the reserved place and restore the position
    this.pos = startPos - 1;
    this.writeVarint(len);
    this.pos += len;
  },

  writePackedVarint(tag, arr) {
    if (arr.length) this.writeMessage(tag, writePackedVarint, arr);
  },

  writeVarintField(tag, val) {
    this.writeVarint((tag << 3) | 0);
    this.writeVarint(val);
  },

  writeBooleanField(tag, val) {
    this.writeVarintField(tag, Boolean(val));
  },
};

function writePackedVarint(arr, pbf) {
  for (let i = 0; i < arr.length; i++) pbf.writeVarint(arr[i]);
}

const withUsage = createDocumentationMessageGenerator({
  name: 'index-widget',
});

type IndexProps = {
  indexName: string;
  indexId?: string;
};

type IndexInitOptions = Pick<
  InitOptions,
  'instantSearchInstance' | 'parent' | 'uiState'
>;

type IndexRenderOptions = Pick<RenderOptions, 'instantSearchInstance'>;

type LocalWidgetSearchParametersOptions = WidgetSearchParametersOptions & {
  initialSearchParameters: SearchParameters;
};

export type Index = Widget & {
  getIndexName(): string;
  getIndexId(): string;
  getHelper(): Helper | null;
  getResults(): SearchResults | null;
  getParent(): Index | null;
  getWidgets(): Widget[];
  addWidgets(widgets: Widget[]): Index;
  removeWidgets(widgets: Widget[]): Index;
  init(options: IndexInitOptions): void;
  render(options: IndexRenderOptions): void;
  dispose(): void;
  /**
   * @deprecated
   */
  getWidgetState(uiState: UiState): UiState;
  getWidgetUiState(uiState: UiState): UiState;
  getWidgetSearchParameters(
    searchParameters: SearchParameters,
    searchParametersOptions: { uiState: IndexUiState }
  ): SearchParameters;
  refreshUiState(): void;
};

export function isIndexWidget(widget: Widget): widget is Index {
  return widget.$$type === 'ais.index';
}

/**
 * This is the same content as helper._change / setState, but allowing for extra
 * UiState to be synchronized.
 * see: https://github.com/algolia/algoliasearch-helper-js/blob/6b835ffd07742f2d6b314022cce6848f5cfecd4a/src/algoliasearch.helper.js#L1311-L1324
 */
function privateHelperSetState(
  helper: AlgoliaSearchHelper,
  {
    state,
    isPageReset,
    _uiState,
  }: {
    state: SearchParameters;
    isPageReset?: boolean;
    _uiState?: IndexUiState;
  }
) {
  if (state !== helper.state) {
    helper.state = state;

    helper.emit('change', {
      state: helper.state,
      results: helper.lastResults,
      isPageReset,
      _uiState,
    });
  }
}

function getLocalWidgetsState(
  widgets: Widget[],
  widgetStateOptions: WidgetUiStateOptions,
  initialUiState: IndexUiState = {}
): IndexUiState {
  return widgets
    .filter(widget => !isIndexWidget(widget))
    .reduce<IndexUiState>((uiState, widget) => {
      if (!widget.getWidgetUiState && !widget.getWidgetState) {
        return uiState;
      }

      if (widget.getWidgetUiState) {
        return widget.getWidgetUiState(uiState, widgetStateOptions);
      }

      return widget.getWidgetState!(uiState, widgetStateOptions);
    }, initialUiState);
}

function getLocalWidgetsSearchParameters(
  widgets: Widget[],
  widgetSearchParametersOptions: LocalWidgetSearchParametersOptions
): SearchParameters {
  const { initialSearchParameters, ...rest } = widgetSearchParametersOptions;

  return widgets
    .filter(widget => !isIndexWidget(widget))
    .reduce<SearchParameters>((state, widget) => {
      if (!widget.getWidgetSearchParameters) {
        return state;
      }

      return widget.getWidgetSearchParameters(state, rest);
    }, initialSearchParameters);
}

function resetPageFromWidgets(widgets: Widget[]): void {
  const indexWidgets = widgets.filter(isIndexWidget);

  if (indexWidgets.length === 0) {
    return;
  }

  indexWidgets.forEach(widget => {
    const widgetHelper = widget.getHelper()!;

    privateHelperSetState(widgetHelper, {
      // @ts-ignore @TODO: remove "ts-ignore" once `resetPage()` is typed in the helper
      state: widgetHelper.state.resetPage(),
      isPageReset: true,
    });

    resetPageFromWidgets(widget.getWidgets());
  });
}

function resolveScopedResultsFromWidgets(widgets: Widget[]): ScopedResult[] {
  const indexWidgets = widgets.filter(isIndexWidget);

  return indexWidgets.reduce<ScopedResult[]>((scopedResults, current) => {
    return scopedResults.concat(
      {
        indexId: current.getIndexId(),
        results: current.getResults()!,
        helper: current.getHelper()!,
      },
      ...resolveScopedResultsFromWidgets(current.getWidgets())
    );
  }, []);
}

function resolveScopedResultsFromIndex(widget: Index): ScopedResult[] {
  const widgetParent = widget.getParent();
  // If the widget is the root, we consider itself as the only sibling.
  const widgetSiblings = widgetParent ? widgetParent.getWidgets() : [widget];

  return resolveScopedResultsFromWidgets(widgetSiblings);
}

const index = (props: IndexProps): Index => {
  if (props === undefined || props.indexName === undefined) {
    throw new Error(withUsage('The `indexName` option is required.'));
  }

  const { indexName, indexId = indexName } = props;

  let localWidgets: Widget[] = [];
  let localUiState: IndexUiState = {};
  let localInstantSearchInstance: InstantSearch | null = null;
  let localParent: Index | null = null;
  let helper: Helper | null = null;
  let derivedHelper: DerivedHelper | null = null;

  const createURL = (nextState: SearchParameters) =>
    localInstantSearchInstance!._createURL!({
      [indexId]: getLocalWidgetsState(localWidgets, {
        searchParameters: nextState,
        helper: helper!,
      }),
    });

  return {
    $$type: 'ais.index',

    getIndexName() {
      return indexName;
    },

    getIndexId() {
      return indexId;
    },

    getHelper() {
      return helper;
    },

    getResults() {
      return derivedHelper && derivedHelper.lastResults;
    },

    getParent() {
      return localParent;
    },

    getWidgets() {
      return localWidgets;
    },

    addWidgets(widgets) {
      if (!Array.isArray(widgets)) {
        throw new Error(
          withUsage('The `addWidgets` method expects an array of widgets.')
        );
      }

      if (
        widgets.some(
          widget =>
            typeof widget.init !== 'function' &&
            typeof widget.render !== 'function'
        )
      ) {
        throw new Error(
          withUsage(
            'The widget definition expects a `render` and/or an `init` method.'
          )
        );
      }

      localWidgets = localWidgets.concat(widgets);

      if (localInstantSearchInstance && Boolean(widgets.length)) {
        privateHelperSetState(helper!, {
          state: getLocalWidgetsSearchParameters(localWidgets, {
            uiState: localUiState,
            initialSearchParameters: helper!.state,
          }),
          _uiState: localUiState,
        });

        // We compute the render state before calling `init` in a separate loop
        // to construct the whole render state object that is then passed to
        // `init`.
        widgets.forEach(widget => {
          if (widget.getRenderState) {
            const renderState = widget.getRenderState(
              localInstantSearchInstance!.renderState[this.getIndexId()] || {},
              {
                uiState: localInstantSearchInstance!._initialUiState,
                helper: this.getHelper()!,
                parent: this,
                instantSearchInstance: localInstantSearchInstance!,
                state: helper!.state,
                renderState: localInstantSearchInstance!.renderState,
                templatesConfig: localInstantSearchInstance!.templatesConfig,
                createURL,
                scopedResults: [],
                searchMetadata: {
                  isSearchStalled: localInstantSearchInstance!._isSearchStalled,
                },
              }
            );

            storeRenderState({
              renderState,
              instantSearchInstance: localInstantSearchInstance!,
              parent: this,
            });
          }
        });

        widgets.forEach(widget => {
          if (widget.init) {
            localInstantSearchInstance!.telemetry.updatePayload({
              type:
                WidgetType[widget.$$type]?.value ||
                WidgetType['ais.custom'].value,
              params: widget.$$params
                ? Object.keys(widget.$$params)
                    .map(param => WidgetParams[param]?.value)
                    .filter(Boolean)
                : [],
              useConnector: !widget.$$params,
            });

            widget.init({
              helper: helper!,
              parent: this,
              uiState: localInstantSearchInstance!._initialUiState,
              instantSearchInstance: localInstantSearchInstance!,
              state: helper!.state,
              renderState: localInstantSearchInstance!.renderState,
              templatesConfig: localInstantSearchInstance!.templatesConfig,
              createURL,
              scopedResults: [],
              searchMetadata: {
                isSearchStalled: localInstantSearchInstance!._isSearchStalled,
              },
            });
          }
        });

        localInstantSearchInstance.scheduleSearch();
      }

      return this;
    },

    removeWidgets(widgets) {
      if (!Array.isArray(widgets)) {
        throw new Error(
          withUsage('The `removeWidgets` method expects an array of widgets.')
        );
      }

      if (widgets.some(widget => typeof widget.dispose !== 'function')) {
        throw new Error(
          withUsage('The widget definition expects a `dispose` method.')
        );
      }

      localWidgets = localWidgets.filter(
        widget => widgets.indexOf(widget) === -1
      );

      if (localInstantSearchInstance && Boolean(widgets.length)) {
        const nextState = widgets.reduce((state, widget) => {
          // the `dispose` method exists at this point we already assert it
          const next = widget.dispose!({ helper: helper!, state });

          return next || state;
        }, helper!.state);

        localUiState = getLocalWidgetsState(localWidgets, {
          searchParameters: nextState,
          helper: helper!,
        });

        helper!.setState(
          getLocalWidgetsSearchParameters(localWidgets, {
            uiState: localUiState,
            initialSearchParameters: nextState,
          })
        );

        if (localWidgets.length) {
          localInstantSearchInstance.scheduleSearch();
        }
      }

      return this;
    },

    init({ instantSearchInstance, parent, uiState }: IndexInitOptions) {
      instantSearchInstance.telemetry.updatePayload({
        type: WidgetType['ais.index'].value,
        params: Object.keys(props)
          .map(param => WidgetParams[param]?.value)
          .filter(Boolean),
        useConnector: false,
      });

      localInstantSearchInstance = instantSearchInstance;
      localParent = parent;
      localUiState = uiState[indexId] || {};

      // The `mainHelper` is already defined at this point. The instance is created
      // inside InstantSearch at the `start` method, which occurs before the `init`
      // step.
      const mainHelper = instantSearchInstance.mainHelper!;
      const parameters = getLocalWidgetsSearchParameters(localWidgets, {
        uiState: localUiState,
        initialSearchParameters: new algoliasearchHelper.SearchParameters({
          index: indexName,
        }),
      });
      let telemetryHeader = '';

      // This Helper is only used for state management we do not care about the
      // `searchClient`. Only the "main" Helper created at the `InstantSearch`
      // level is aware of the client.
      helper = algoliasearchHelper(
        {} as SearchClient,
        parameters.index,
        parameters
      );

      // We forward the call to `search` to the "main" instance of the Helper
      // which is responsible for managing the queries (it's the only one that is
      // aware of the `searchClient`).
      helper.search = () => {
        if (instantSearchInstance.onStateChange) {
          instantSearchInstance.onStateChange!({
            uiState: instantSearchInstance.mainIndex.getWidgetUiState({}),
            setUiState: instantSearchInstance.setUiState.bind(
              instantSearchInstance
            ),
          });

          // We don't trigger a search when controlled because it becomes the
          // responsibility of `setUiState`.
          return mainHelper;
        }

        return mainHelper.search();
      };

      (helper as any).searchWithoutTriggeringOnStateChange = () => {
        return mainHelper.search();
      };

      // We use the same pattern for the `searchForFacetValues`.
      helper.searchForFacetValues = (
        facetName,
        facetValue,
        maxFacetHits,
        userState: PlainSearchParameters
      ) => {
        const state = helper!.state.setQueryParameters(userState);

        return mainHelper.searchForFacetValues(
          facetName,
          facetValue,
          maxFacetHits,
          state
        );
      };

      derivedHelper = mainHelper.derive(() =>
        mergeSearchParameters(...resolveSearchParameters(this))
      );

      // Subscribe to the Helper state changes for the page before widgets
      // are initialized. This behavior mimics the original one of the Helper.
      // It makes sense to replicate it at the `init` step. We have another
      // listener on `change` below, once `init` is done.
      helper.on('change', ({ isPageReset }) => {
        if (isPageReset) {
          resetPageFromWidgets(localWidgets);
        }
      });

      derivedHelper.on('search', () => {
        const pbf = new Pbf();
        const payload = instantSearchInstance.telemetry.getPayload();
        Schema.write(payload, pbf);
        const arrayBuffer = pbf.finish();
        const newTelemetryHeader = window.btoa(
          String.fromCharCode.apply(null, arrayBuffer)
        );

        const mappedPayload = payload.widgets.map(widget => ({
          type: Object.keys(WidgetType).find(
            type => WidgetType[type].value === widget.type
          ),
          params: widget.params.map(paramId =>
            Object.keys(WidgetParams).find(
              type => WidgetParams[type].value === paramId
            )
          ),
          useConnector: widget.useConnector,
        }));

        console.log('Telemetry payload', payload);
        console.log('Telemetry mapped payload', mappedPayload);
        console.log('Telemetry header', newTelemetryHeader);

        if (telemetryHeader !== newTelemetryHeader) {
          telemetryHeader = newTelemetryHeader;
          instantSearchInstance.client.transporter.queryParameters[
            'x-algolia-telemetry'
          ] = telemetryHeader;
        } else {
          delete instantSearchInstance.client.transporter.queryParameters[
            'x-algolia-telemetry'
          ];
        }

        // The index does not manage the "staleness" of the search. This is the
        // responsibility of the main instance. It does not make sense to manage
        // it at the index level because it's either: all of them or none of them
        // that are stalled. The queries are performed into a single network request.
        instantSearchInstance.scheduleStalledRender();

        if (__DEV__) {
          checkIndexUiState({ index: this, indexUiState: localUiState });
        }
      });

      derivedHelper.on('result', ({ results }) => {
        // The index does not render the results it schedules a new render
        // to let all the other indices emit their own results. It allows us to
        // run the render process in one pass.
        instantSearchInstance.scheduleRender();

        // the derived helper is the one which actually searches, but the helper
        // which is exposed e.g. via instance.helper, doesn't search, and thus
        // does not have access to lastResults, which it used to in pre-federated
        // search behavior.
        helper!.lastResults = results;
      });

      // We compute the render state before calling `render` in a separate loop
      // to construct the whole render state object that is then passed to
      // `render`.
      localWidgets.forEach(widget => {
        if (widget.getRenderState) {
          const renderState = widget.getRenderState(
            instantSearchInstance.renderState[this.getIndexId()] || {},
            {
              uiState,
              helper: helper!,
              parent: this,
              instantSearchInstance,
              state: helper!.state,
              renderState: instantSearchInstance.renderState,
              templatesConfig: instantSearchInstance.templatesConfig,
              createURL,
              scopedResults: [],
              searchMetadata: {
                isSearchStalled: instantSearchInstance._isSearchStalled,
              },
            }
          );

          storeRenderState({
            renderState,
            instantSearchInstance,
            parent: this,
          });
        }
      });

      localWidgets.forEach(widget => {
        warning(
          !widget.getWidgetState,
          'The `getWidgetState` method is renamed `getWidgetUiState` and will no longer exist under that name in InstantSearch.js 5.x. Please use `getWidgetUiState` instead.'
        );

        if (widget.init) {
          instantSearchInstance.telemetry.updatePayload({
            type:
              WidgetType[widget.$$type]?.value ||
              WidgetType['ais.custom'].value,
            params: widget.$$params
              ? Object.keys(widget.$$params)
                  .map(param => WidgetParams[param]?.value)
                  .filter(Boolean)
              : [],
            useConnector: !widget.$$params,
          });

          widget.init({
            uiState,
            helper: helper!,
            parent: this,
            instantSearchInstance,
            state: helper!.state,
            renderState: instantSearchInstance.renderState,
            templatesConfig: instantSearchInstance.templatesConfig,
            createURL,
            scopedResults: [],
            searchMetadata: {
              isSearchStalled: instantSearchInstance._isSearchStalled,
            },
          });
        }
      });

      // Subscribe to the Helper state changes for the `uiState` once widgets
      // are initialized. Until the first render, state changes are part of the
      // configuration step. This is mainly for backward compatibility with custom
      // widgets. When the subscription happens before the `init` step, the (static)
      // configuration of the widget is pushed in the URL. That's what we want to avoid.
      // https://github.com/algolia/instantsearch.js/pull/994/commits/4a672ae3fd78809e213de0368549ef12e9dc9454
      helper.on('change', event => {
        const { state } = event;

        // @ts-ignore _uiState comes from privateHelperSetState and thus isn't typed on the helper event
        const _uiState = event._uiState;

        localUiState = getLocalWidgetsState(
          localWidgets,
          {
            searchParameters: state,
            helper: helper!,
          },
          _uiState || {}
        );

        // We don't trigger an internal change when controlled because it
        // becomes the responsibility of `setUiState`.
        if (!instantSearchInstance.onStateChange) {
          instantSearchInstance.onInternalStateChange();
        }
      });
    },

    render({ instantSearchInstance }: IndexRenderOptions) {
      if (!this.getResults()) {
        return;
      }

      localWidgets.forEach(widget => {
        if (widget.getRenderState) {
          const renderState = widget.getRenderState(
            instantSearchInstance.renderState[this.getIndexId()] || {},
            {
              helper: this.getHelper()!,
              parent: this,
              instantSearchInstance,
              results: this.getResults()!,
              scopedResults: resolveScopedResultsFromIndex(this),
              state: this.getResults()!._state,
              renderState: instantSearchInstance.renderState,
              templatesConfig: instantSearchInstance.templatesConfig,
              createURL,
              searchMetadata: {
                isSearchStalled: instantSearchInstance._isSearchStalled,
              },
            }
          );

          storeRenderState({
            renderState,
            instantSearchInstance,
            parent: this,
          });
        }
      });

      localWidgets.forEach(widget => {
        // At this point, all the variables used below are set. Both `helper`
        // and `derivedHelper` have been created at the `init` step. The attribute
        // `lastResults` might be `null` though. It's possible that a stalled render
        // happens before the result e.g with a dynamically added index the request might
        // be delayed. The render is triggered for the complete tree but some parts do
        // not have results yet.

        if (widget.render) {
          widget.render({
            helper: helper!,
            parent: this,
            instantSearchInstance,
            results: this.getResults()!,
            scopedResults: resolveScopedResultsFromIndex(this),
            state: this.getResults()!._state,
            renderState: instantSearchInstance.renderState,
            templatesConfig: instantSearchInstance.templatesConfig,
            createURL,
            searchMetadata: {
              isSearchStalled: instantSearchInstance._isSearchStalled,
            },
          });
        }
      });
    },

    dispose() {
      localWidgets.forEach(widget => {
        if (widget.dispose) {
          // The dispose function is always called once the instance is started
          // (it's an effect of `removeWidgets`). The index is initialized and
          // the Helper is available. We don't care about the return value of
          // `dispose` because the index is removed. We can't call `removeWidgets`
          // because we want to keep the widgets on the instance, to allow idempotent
          // operations on `add` & `remove`.
          widget.dispose({ helper: helper!, state: helper!.state });
        }
      });

      localInstantSearchInstance = null;
      localParent = null;
      helper!.removeAllListeners();
      helper = null;

      derivedHelper!.detach();
      derivedHelper = null;
    },

    getWidgetUiState(uiState: UiState) {
      return localWidgets
        .filter(isIndexWidget)
        .reduce<UiState>(
          (previousUiState, innerIndex) =>
            innerIndex.getWidgetUiState(previousUiState),
          {
            ...uiState,
            [this.getIndexId()]: localUiState,
          }
        );
    },

    getWidgetState(uiState: UiState) {
      warning(
        false,
        'The `getWidgetState` method is renamed `getWidgetUiState` and will no longer exist under that name in InstantSearch.js 5.x. Please use `getWidgetUiState` instead.'
      );

      return this.getWidgetUiState(uiState);
    },

    getWidgetSearchParameters(searchParameters, { uiState }) {
      return getLocalWidgetsSearchParameters(localWidgets, {
        uiState,
        initialSearchParameters: searchParameters,
      });
    },

    refreshUiState() {
      localUiState = getLocalWidgetsState(localWidgets, {
        searchParameters: this.getHelper()!.state,
        helper: this.getHelper()!,
      });
    },
  };
};

export default index;

function storeRenderState({ renderState, instantSearchInstance, parent }) {
  const parentIndexName = parent
    ? parent.getIndexId()
    : instantSearchInstance.mainIndex.getIndexId();

  instantSearchInstance.renderState = {
    ...instantSearchInstance.renderState,
    [parentIndexName]: {
      ...instantSearchInstance.renderState[parentIndexName],
      ...renderState,
    },
  };
}
