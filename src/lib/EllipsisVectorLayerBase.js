import EllipsisApi from "./EllipsisApi";
import EllipsisVectorLayerBaseError from "./EllipsisVectorLayerError";
import {
  getFeatureStyling,
  extractStyling,
  getStyleKeys,
} from "./VectorLayerUtil";

class EllipsisVectorLayerBase {
  static defaultOptions = {
    centerPoints: false,
    pageSize: 50,
    chunkSize: 10,
    maxMbPerTile: 16,
    maxTilesInCache: 500,
    maxFeaturesPerTile: 500,
    useMarkers: false,
    loadAll: false,
    fetchInterval: 0,
    levelOfDetailMode: "dynamic",
    levelOfDetailMapper: (zoom) => {
      const transitions = [3, 6, 9, 12, 15];
      const detailLevel = transitions.findIndex((x) => zoom < x) + 1;
      return detailLevel === 0 ? 6 : detailLevel;
    },
    levelOfDetail: 6,
  };

  static optionModifiers = {
    pageSize: (pageSize) => Math.min(3000, pageSize),
    maxMbPerTile: (maxMbPerTile) => maxMbPerTile * 1000000,
    debug: (debug) => (debug ? (msg) => console.log(msg) : () => {}),
  };

  loadingState = {
    loadInterrupters: [],
    loadingTimeout: undefined,
    cache: {}, // {featureId: [{feature_lod_1}, {feature_lod_2}, ..., {feature_lod_6}], otherFeatureId: [...]}
    featuresInTileCache: {}, // {tileId: {featureIds: [], ...}, otherTileId: {featureIds: [], ...}}
    nextPageStart: Array(6),
    isLoading: false,
    updateLock: false,
    missedCall: false,
  };

  info = {
    layerInfo: undefined,
    style: undefined,
  };

  tiles = [];
  zoom = 1;

  //TODO change the names, and handle undefined style keys
  loadOptions = {
    styleKeys: undefined,
    onEachFeature: undefined,
  };

  //Abstract functions
  getMapBounds = () => console.error("get map bounds not implemented");
  updateView = () => console.error("update view not implemented");

  constructor(options = {}) {
    if (!options.pathId) {
      options.pathId = options.blockId || options.mapId;

      if (options.pathId)
        console.warn(
          "We recommended to use the property name pathId instead of mapId or blockId to identify ellipsis drive maps to reduce confusion with other libraries."
        );
    }

    if (!options.pathId) {
      throw new EllipsisVectorLayerBaseError("You did not specify a path ID.");
    }

    if (!options.timestampId && options.layerId) {
      options.timestampId = options.layerId;
      console.warn(
        "We recommended to use the property name timestampId instead of layerId to identify ellipsis drive timestamps."
      );
    }

    Object.keys(EllipsisVectorLayerBase.defaultOptions).forEach((x) => {
      if (options[x] == undefined)
        options[x] = EllipsisVectorLayerBase.defaultOptions[x];
    });
    Object.keys(EllipsisVectorLayerBase.optionModifiers).forEach(
      (x) =>
        (options[x] = EllipsisVectorLayerBase.optionModifiers[x](options[x]))
    );
    this.options = {};
    Object.keys(options).forEach((x) => (this.options[x] = options[x]));

    this.id = `${this.options.pathId}_${this.options.timestampId}`;

    if (this.options.levelOfDetailMode === "dynamic")
      this.levelOfDetail = this.options.levelOfDetailMapper(this.zoom);
    else this.levelOfDetail = this.options.levelOfDetail;
  }

  getLayerInfo = () => {
    return this.info.layerInfo;
  };

  getFeatures = () => {
    if (this.options.loadAll) {
      return Object.values(this.loadingState.cache)
        .map((featureCache) => featureCache[this.levelOfDetail - 1])
        .filter((x) => x);
    }
    return this.tiles.flatMap((t) => {
      const featureIdsInTile =
        this.loadingState.featuresInTileCache[
          this.getTileId(t, this.levelOfDetail)
        ]?.featureIds;
      if (!featureIdsInTile) return [];
      return featureIdsInTile
        .map((idInTile) => {
          const cachedFeature = this.loadingState.cache[idInTile];
          return cachedFeature && cachedFeature[this.levelOfDetail - 1];
        })
        .filter((x) => x);
    });
  };

  clearLayer = async () => {
    await this.awaitNotLoading();
    this.loadingState.cache = {};
    this.loadingState.featuresInTileCache = {};
    this.loadingState.nextPageStart = Array(6);
  };

  /**
   * Load everything in current map bounds.
   */
  update = async () => {
    if (this.loadingState.updateLock) return;
    this.options.debug("update..");
    if (!this.info.layerInfo) {
      this.loadingState.updateLock = true;
      await this.fetchLayerInfo();
      this.fetchStylingInfo();
      this.loadingState.updateLock = false;
      this.options.debug("fetched layer info:");
      this.options.debug(this.info.layerInfo);
      this.options.debug("fetched style info:");
      this.options.debug(this.info.style);
    }

    //Don't lock the entire context because we want update to be able to re-calculate tiles
    //while fetching data.
    const viewport = this.getMapBounds();

    if (!viewport) return;

    const maxZoom =
      this.options.maxZoom === undefined
        ? this.info.layerInfo.zoom
        : this.options.maxZoom;

    this.zoom = Math.max(Math.min(maxZoom, viewport.zoom - 2), 0);
    if (this.options.levelOfDetailMode === "dynamic")
      this.levelOfDetail = this.options.levelOfDetailMapper(viewport.zoom - 2);

    this.tiles = this.boundsToTiles(viewport.bounds, this.zoom);

    const lodChanged =
      !this.previousLevelOfDetail ||
      this.previousLevelOfDetail !== this.levelOfDetail;
    if (lodChanged && this.options.levelOfDetailMode === "dynamic") {
      this.options.debug(
        `level of detail changed from ${this.previousLevelOfDetail} to ${this.levelOfDetail}`
      );
      this.previousLevelOfDetail = this.levelOfDetail;
      this.updateView();
    }
    this.load(() => {
      this.updateView();
    }, this.options.fetchInterval);
  };

  load = async (onload, timeout) => {
    if (this.loadingState.loadingTimeout) return;

    //Keep track of missed call in case an update happened while a load cached nothing.
    if (this.loadingState.isLoading) {
      this.loadingState.missedCall = true;
      return;
    }
    this.loadingState.missedCall = false;

    this.options.debug("load");
    this.loadingState.isLoading = true;
    const cachedSomething = this.options.loadAll
      ? await this.requestAllGeoJsons()
      : await this.requestTileGeoJsons();
    this.loadingState.isLoading = false;
    //Handle load interrupts
    if (this.loadingState.loadInterrupters.length) {
      this.loadingState.loadingTimeout = undefined;
      this.loadingState.loadInterrupters.forEach((x) => x());
      this.loadingState.loadInterrupters = [];
      return;
    }

    if (!cachedSomething && !this.loadingState.missedCall) {
      this.options.debug("did not cache new data");
      this.ensureMaxCacheSize();
      return;
    }
    this.options.debug(
      "loaded new data, page start: " + this.loadingState.nextPageStart
    );
    onload();
    this.loadingState.loadingTimeout = setTimeout(() => {
      this.loadingState.loadingTimeout = undefined;
      this.load(onload, timeout);
    }, timeout);
  };

  awaitNotLoading = (force) =>
    new Promise((res, rej) => {
      if (!this.loadingState.loadingTimeout && !this.loadingState.isLoading)
        return res();

      if (this.loadingState.isLoading)
        return this.loadingState.loadInterrupters.push(() => res());

      if (this.loadingState.loadingTimeout) {
        clearTimeout(this.loadingState.loadingTimeout);
        this.loadingState.loadingTimeout = undefined;
        if (!force) return setTimeout(() => res(), this.options.fetchInterval);
        return res();
      }

      rej();
    });

  ensureMaxCacheSize = () => {
    if (this.options.maxTilesInCache === undefined) return;
    const keys = Object.keys(this.loadingState.featuresInTileCache);
    if (keys.length > this.options.maxTilesInCache) {
      this.options.debug(
        "There are too many tiles in the cache, removing the oldest ones."
      );
      const dates = keys
        .map((k) => this.loadingState.featuresInTileCache[k].date)
        .sort();
      const clipValue = dates[9];
      keys.forEach((key) => {
        if (this.loadingState.featuresInTileCache[key].date <= clipValue) {
          //Make sure that any features that are referenced to by the to-be-deleted
          //featuresInTileCache are deleted if they are not referenced elsewhere.
          const danglingFeatures =
            this.loadingState.featuresInTileCache[key].featurIds ?? [];
          const referencedFeatures = [];
          const toBeDeleted = this.loadingState.featuresInTileCache[key];
          Object.entries(this.loadingState.featuresInTileCache).forEach(
            ([k, v]) => {
              if (k === key) return;
              if (v.levelOfDetail !== toBeDeleted.levelOfDetail) return;

              danglingFeatures.forEach((d) => {
                if (v.featureIds.includes(d) && !referencedFeatures.includes(d))
                  referencedFeatures.push(d);
              });
            }
          );

          danglingFeatures
            .filter((x) => !referencedFeatures.includes(x))
            .forEach((d) => {
              delete this.loadingState.cache[d][toBeDeleted.levelOfDetail - 1];
            });

          //Now delete the tile that references the features inside it.
          delete this.loadingState.featuresInTileCache[key];
        }
      });
    }
  };

  requestAllGeoJsons = async () => {
    const levelOfDetailSnapshot = this.levelOfDetail;

    if (this.loadingState.nextPageStart[levelOfDetailSnapshot - 1] === 4)
      //TODO, load again when lod changes
      return false;

    const body = {
      pageStart: this.loadingState.nextPageStart[levelOfDetailSnapshot - 1],
      returnType: this.getReturnType(),
      zipTheResponse: true,
      pageSize: Math.min(3000, this.options.pageSize),
      styleId: this.options.styleId,
      style: this.options.style,
      levelOfDetail: this.levelOfDetail === 6 ? undefined : this.levelOfDetail,
    };

    try {
      const res = await EllipsisApi.get(
        `/path/${this.options.pathId}/vector/timestamp/${this.options.timestampId}/listFeatures`,
        body,
        { token: this.options.token }
      );
      this.loadingState.nextPageStart[levelOfDetailSnapshot - 1] =
        res.nextPageStart;
      if (!res.nextPageStart)
        this.loadingState.nextPageStart[levelOfDetailSnapshot - 1] = 4; //EOT (end of transmission)
      if (res.result && res.result.features) {
        res.result.features.forEach((x) => {
          this.compileStyle(x);
          if (this.loadOptions.onEachFeature) this.loadOptions.onEachFeature(x);
          if (!this.loadingState.cache[x.properties.id])
            this.loadingState.cache[x.properties.id] = Array(6);
          this.loadingState.cache[x.properties.id][levelOfDetailSnapshot - 1] =
            x;
        });
      }
    } catch (e) {
      console.error("an error occured with getting all features");
      console.error(e);
      return false;
    }
    return true;
  };

  requestTileGeoJsons = async () => {
    const date = Date.now();
    const levelOfDetailSnapshot = this.levelOfDetail;
    //create tiles parameter which contains tiles that need to load more features
    const tiles = this.tiles
      .map((t) => {
        const tileId = this.getTileId(t, levelOfDetailSnapshot);

        //If not cached, always try to load features.
        if (!this.loadingState.featuresInTileCache[tileId])
          return {
            tileId: t,
            levelOfDetail:
              levelOfDetailSnapshot === 6 ? undefined : levelOfDetailSnapshot,
          };

        const pageStart =
          this.loadingState.featuresInTileCache[tileId].nextPageStart;

        //Check if tile is not already fully loaded, and if more features may be loaded
        if (
          pageStart &&
          this.loadingState.featuresInTileCache[tileId].amount <=
            this.options.maxFeaturesPerTile &&
          this.loadingState.featuresInTileCache[tileId].size <=
            this.options.maxMbPerTile
        )
          return {
            tileId: t,
            pageStart,
            levelOfDetail:
              levelOfDetailSnapshot === 6 ? undefined : levelOfDetailSnapshot,
          };

        return null;
      })
      .filter((x) => x);

    if (tiles.length === 0) return false;

    const body = {
      returnType: this.getReturnType(),
      zipTheResponse: true,
      pageSize: this.options.pageSize,
      styleId: this.options.styleId,
      style: this.options.style,
      propertyFilter:
        this.options.filter && this.options.filter > 0
          ? this.options.filter
          : null,
    };

    //Get new geometry for the tiles
    let result = [];
    const chunkSize = this.options.chunkSize;
    for (let k = 0; k < tiles.length; k += chunkSize) {
      body.tiles = tiles.slice(k, k + chunkSize);
      try {
        const res = await EllipsisApi.get(
          `/path/${this.options.pathId}/vector/timestamp/${this.options.timestampId}/featuresByTiles`,
          body,
          { token: this.options.token }
        );
        result = result.concat(res);
      } catch (e) {
        console.error("an error occured with getting tile features");
        console.error(e);
        return false;
      }
    }

    //Add newly loaded data to cache
    for (let j = 0; j < tiles.length; j++) {
      const tileId = this.getTileId(tiles[j].tileId, levelOfDetailSnapshot);

      if (!this.loadingState.featuresInTileCache[tileId]) {
        this.loadingState.featuresInTileCache[tileId] = {
          size: 0,
          amount: 0,
          featureIds: [],
          nextPageStart: null,
        };
      }

      // Update tile cache with new feature ids etc.
      const tileData = this.loadingState.featuresInTileCache[tileId];
      tileData.date = date;
      tileData.size = tileData.size + result[j].size;
      tileData.amount = tileData.amount + result[j].result.features.length;
      tileData.levelOfDetail = levelOfDetailSnapshot;
      tileData.nextPageStart = result[j].nextPageStart;
      if (result[j].result.features) {
        result[j].result.features.forEach((x) => {
          this.compileStyle(x);
          if (this.loadOptions.onEachFeature) this.loadOptions.onEachFeature(x);
        });
      }
      tileData.featureIds.push(
        ...result[j].result.features.map((feature) => feature.properties.id)
      );

      // Cache feature by id
      result[j].result.features.forEach((feature) => {
        const featureId = feature.properties.id;
        if (!this.loadingState.cache[featureId])
          this.loadingState.cache[featureId] = new Array(6);
        if (!this.loadingState.cache[featureId][levelOfDetailSnapshot - 1]) {
          feature.lod = levelOfDetailSnapshot - 1;
          this.loadingState.cache[featureId][levelOfDetailSnapshot - 1] =
            feature;
        }
      });
    }
    return true;
  };

  //Requests layer info for layer with id layerId. Sets this in state.layerInfo.
  fetchLayerInfo = async () => {
    const info = await EllipsisApi.getPath(this.options.pathId, {
      token: this.options.token,
    });
    if (!info?.vector?.timestamps?.length)
      throw new EllipsisVectorLayerBaseError(
        `Specified path "${this.options.pathId}" does not contain any data.`
      );

    if (info.trashed) console.warn("Path is trashed.");
    if (info.type !== "vector")
      throw new EllipsisVectorLayerBaseError("Path info type is not vector.");

    const timestamps = info.vector.timestamps;

    const defaultTimestamp = timestamps.find(
      (timestamp) =>
        !timestamp.trashed &&
        !timestamp.blocked &&
        timestamp.status === "active"
    );

    //Use default when non layer is specified.
    if (!this.options.timestampId && defaultTimestamp) {
      this.info.layerInfo = defaultTimestamp;
      this.options.debug(
        `No timestamp ID specified. Picked default ${defaultTimestamp.id}`
      );
      return;
    }

    const specifiedTimestamp = timestamps.find(
      (timestamp) => timestamp.id === this.options.timestampId
    );

    //Prioritize using the specified layer.
    if (specifiedTimestamp) {
      this.info.layerInfo = specifiedTimestamp;
      return;
    }

    //Fallback on defaultLayer with warning when specifiedLayer is not valid.
    if (!specifiedTimestamp && defaultTimestamp) {
      this.info.layerInfo = defaultTimestamp;
      this.options.debug(
        `No correct timestamp ID specified. Picked default ${defaultTimestamp.id}`
      );
      return;
    }

    //Throw error when no layer is found to stop any execution with wrong parameters.
    if (!specifiedTimestamp && !defaultTimestamp)
      throw new EllipsisVectorLayerBaseError(
        `Specified timestamp with id=${this.options.timestampId} does not exist and the path has no default timestamp to use as a fallback.`
      );
  };

  //Reads relevant styling info from state.layerInfo. Sets this in state.styleInfo.
  fetchStylingInfo = () => {
    const keysToExtract = getStyleKeys({ blacklist: ["radius"] });
    if (!this.options.styleId && this.options.style) {
      this.info.style = this.options.style
        ? extractStyling(this.options.style.parameters, keysToExtract)
        : undefined;
      return;
    }
    if (!this.info.layerInfo || !this.info.layerInfo.styles) {
      this.info.style = undefined;
      //TODO: do we want to throw an error here?
      throw new EllipsisVectorLayerBaseError("The layer has no style.");
    }

    //Get default or specified style object.
    const rawStyling = this.info.layerInfo.styles.find(
      (s) =>
        s.id === this.options.styleId || (s.isDefault && !this.options.styleId)
    );
    this.info.style =
      rawStyling && rawStyling.parameters
        ? extractStyling(rawStyling.parameters, keysToExtract)
        : undefined;
  };

  getReturnType = () => {
    if (this.options.centerPoints) return "center";
    if (this.info.style.popupProperty) return "all";
    return "geometry";
  };

  recompileStyles = () => {
    this.getFeatures().forEach((x) => this.compileStyle(x));
  };

  compileStyle = (feature) => {
    let compiledStyle = getFeatureStyling(
      feature,
      this.info.style,
      this.options
    );
    compiledStyle = extractStyling(compiledStyle, this.loadOptions.styleKeys);
    if (!feature.properties) feature.properties = {};
    feature.properties.compiledStyle = compiledStyle;
  };

  getTileId = (tile, lod = this.levelOfDetail) =>
    `${tile.zoom}_${tile.tileX}_${tile.tileY}_${lod}`;

  boundsToTiles = (bounds, zoom) => {
    const xMin = Math.max(bounds.xMin, -180);
    const xMax = Math.min(bounds.xMax, 180);
    const yMin = Math.max(bounds.yMin, -85);
    const yMax = Math.min(bounds.yMax, 85);

    const zoomComp = Math.pow(2, zoom);
    const comp1 = zoomComp / 360;
    const pi = Math.PI;
    const comp2 = 2 * pi;
    const comp3 = pi / 4;

    const tileXMin = Math.floor((xMin + 180) * comp1);
    const tileXMax = Math.floor((xMax + 180) * comp1);
    const tileYMin = Math.floor(
      (zoomComp / comp2) * (pi - Math.log(Math.tan(comp3 + (yMax / 360) * pi)))
    );
    const tileYMax = Math.floor(
      (zoomComp / comp2) * (pi - Math.log(Math.tan(comp3 + (yMin / 360) * pi)))
    );

    let tiles = [];
    for (
      let x = Math.max(0, tileXMin - 1);
      x <= Math.min(2 ** zoom - 1, tileXMax + 1);
      x++
    ) {
      for (
        let y = Math.max(0, tileYMin - 1);
        y <= Math.min(2 ** zoom - 1, tileYMax + 1);
        y++
      ) {
        tiles.push({ zoom, tileX: x, tileY: y });
      }
    }
    return tiles;
  };
}

export default EllipsisVectorLayerBase;
