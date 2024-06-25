import EllipsisApi from "./EllipsisApi";
import EllipsisVectorLayerBaseError from "./EllipsisVectorLayerError";
import { getFeatureStyling, getVectorLayerColor } from "./VectorLayerUtil";

class EllipsisVectorLayerBase {
  static defaultOptions = {
    loadAll: false,
    pageSize: 1000,
    chunkSize: 10,
    maxMbPerTile: 32,
    maxRenderTiles: 100,
    maxTilesInCache: 500,
    maxFeaturesPerTile: 10000,
    fetchInterval: 0,
  };

  static optionModifiers = {
    pageSize: (pageSize) => Math.min(1000, pageSize),
    maxMbPerTile: (maxMbPerTile) => maxMbPerTile * 1000000,
    debug: (debug) => (debug ? (msg) => console.log(msg) : () => {}),
  };

  loadingState = {
    loadInterrupters: [],
    loadingTimeout: undefined,
    cache: {}, // {featureId: feature}
    featuresInTileCache: {}, // {tileId: {featureIds: [], ...}, otherTileId: {featureIds: [], ...}}
    nextPageStart: Array(6),
    oldTiles: [],
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

    //Apply option defaults and modifiers, and copy options to 'this' context.
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

    //Conversion to allow passing style id in style option.

    this.id = `${this.options.pathId}_${this.options.timestampId}`;
  }

  getLayerInfo = () => {
    return this.info.layerInfo;
  };

  getTilesAbove = (tile) => {
    const initialZoom = tile.zoom;

    let zoom = tile.zoom;
    let tiles = [];
    while (zoom >= 0) {
      const t = {
        zoom: zoom,
        tileX: Math.floor(tile.tileX / 2 ** (initialZoom - zoom)),
        tileY: Math.floor(tile.tileY / 2 ** (initialZoom - zoom)),
      };

      tiles.push(t);
      zoom = zoom - 1;
    }

    return tiles;
  };

  getFeatures = () => {
    let renderTiles = this.tiles.map((t) => this.getTilesAbove(t));

    renderTiles = renderTiles.flat();

    renderTiles = [...renderTiles, ...this.loadingState.oldTiles];
    let tileIds = renderTiles.map((t) => this.getTileId(t));
    renderTiles = renderTiles.filter(
      (value, index, array) => tileIds.indexOf(this.getTileId(value)) === index
    );

    if (renderTiles.length > this.options.maxRenderTiles) {
      renderTiles = renderTiles.slice(0, this.options.maxRenderTiles);
    }
    this.loadingState.oldTiles = renderTiles;

    const alreadyThere = {};

    let res = renderTiles.flatMap((t) => {
      const featureIdsInTile =
        this.loadingState.featuresInTileCache[this.getTileId(t)]?.featureIds;

      if (!featureIdsInTile) return [];
      return featureIdsInTile
        .map((idInTile) => {
          const cachedFeature = this.loadingState.cache[idInTile];
          if (cachedFeature && cachedFeature && !alreadyThere[idInTile]) {
            alreadyThere[idInTile] = true;
            return cachedFeature;
          } else {
            return null;
          }
        })
        .filter((x) => x);
    });

    return res;
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

    const maxZoom = this.options.loadAll
      ? 0
      : this.options.maxZoom ?? this.options.zoom ?? this.info.layerInfo.zoom;

    this.zoom = Math.max(Math.min(maxZoom, viewport.zoom - 2), 0);

    this.tiles = this.boundsToTiles(viewport.bounds, this.zoom);

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

    const cachedSomething = await this.requestTileGeoJsons();

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
    return;
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

  comparePageStarts = (page1, page2) => {
    let newNextPageStart = page1;

    if (page2) {
      if (
        !page1 ||
        ((!page1.value || page2.value >= page1.value) &&
          page2.featureId > page1.featureId)
      ) {
        newNextPageStart = page2;
      }
    }

    return newNextPageStart;
  };

  getPageStart = (t) => {
    let nextPageStart =
      this.loadingState.featuresInTileCache[this.getTileId(t)].nextPageStart;

    const tiles = this.getTilesAbove(t);
    for (let i = 0; i < tiles.length; i++) {
      const tileId = this.getTileId(tiles[i]);
      if (
        this.loadingState.featuresInTileCache &&
        this.loadingState.featuresInTileCache[tileId] &&
        this.loadingState.featuresInTileCache[tileId].nextPageStart
      ) {
        nextPageStart = this.comparePageStarts(
          nextPageStart,
          this.loadingState.featuresInTileCache[tileId].nextPageStart
        );
      }
    }
    return nextPageStart;
  };

  getStyle = () => {
    console.log("here", this.info.pathStyles, this.options.style);
    const st = !this.options.style
      ? this.info.pathStyles.find((s) => s.default)
      : typeof this.options.style === "string"
      ? this.info.pathStyles.find((x) => x.id === this.options.style)
      : this.options.style;
    console.log("FOUND", st, this.info.pathStyles);
    if (!st) {
      throw new EllipsisVectorLayerBaseError("Given style not found");
    }
    return st;
  };

  requestTileGeoJsons = async () => {
    const date = Date.now();

    //create tiles parameter which contains tiles that need to load more features
    const tiles = this.tiles
      .map((t) => {
        const tileId = this.getTileId(t);

        if (this.loadingState.featuresInTileCache[tileId]?.done) return null;
        //If not cached, always try to load features.
        if (!this.loadingState.featuresInTileCache[tileId])
          return {
            tileId: t,
          };

        const pageStart = this.getPageStart(t);

        //Check if tile is not already fully loaded, and if more features may be loaded
        if (
          (pageStart &&
            this.loadingState.featuresInTileCache[tileId].amount <=
              this.options.maxFeaturesPerTile &&
            this.loadingState.featuresInTileCache[tileId].size <=
              this.options.maxMbPerTile) ||
          (this.options.loadAll && pageStart)
        )
          return {
            tileId: t,
            pageStart,
          };

        return null;
      })
      .filter((x) => x);

    if (tiles.length === 0) return false;

    const body = {
      zipTheResponse: true,
      pageSize: this.options.pageSize,
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
        let res;

        if (this.options.loadAll && !body.tiles[0].pageStart) {
          res = await EllipsisApi.get(
            `/path/${this.options.pathId}/vector/timestamp/${this.info.layerInfo.id}/compressedListFeatures`,
            body,
            { token: this.options.token }
          );
          res.nextPageStart = res.nextPageStart
            ? { featureId: res.nextPageStart }
            : null;

          const st = this.getStyle();

          res.result.features = res.result.features.map((f) => {
            f.properties.color = getVectorLayerColor(f.properties, st);
            return f;
          });
        } else {
          res = await EllipsisApi.get(
            `/path/${this.options.pathId}/vector/timestamp/${this.info.layerInfo.id}/featuresByTiles`,
            body,
            { token: this.options.token }
          );
        }

        result = result.concat(res);
      } catch (e) {
        console.error("an error occured with getting tile features");
        console.error(e);
        return false;
      }
    }

    //Add newly loaded data to cache
    for (let j = 0; j < tiles.length; j++) {
      const tileId = this.getTileId(tiles[j].tileId);

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
      tileData.nextPageStart = result[j].nextPageStart;
      tileData.done = !result[j].nextPageStart;
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

        if (!this.loadingState.cache[featureId]) {
          this.loadingState.cache[featureId] = feature;
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
    console.log("info", info);
    if (!info?.vector?.timestamps?.length)
      throw new EllipsisVectorLayerBaseError(
        `Specified path "${this.options.pathId}" does not contain any data.`
      );

    if (info.trashed) console.warn("Path is trashed.");
    if (info.type !== "vector")
      throw new EllipsisVectorLayerBaseError("Path info type is not vector.");

    const timestamps = info.vector.timestamps;
    this.info.pathStyles = info.vector.styles;
    console.log(this.info.pathStyles);
    const defaultTimestamp = timestamps
      ?.reverse()
      .find(
        (timestamp) =>
          !timestamp.trashed &&
          !timestamp.availability.blocked &&
          timestamp.status === "active"
      );

    //Use default when non layer is specified.
    if (!this.options.timestampId && defaultTimestamp) {
      this.info.layerInfo = defaultTimestamp;
      this.options.debug(
        `No timestamp ID specified. Picked default ${defaultTimestamp.id}`
      );
    } else {
      const specifiedTimestamp = timestamps.find(
        (timestamp) => timestamp.id === this.options.timestampId
      );

      //Prioritize using the specified layer.
      if (specifiedTimestamp) {
        this.info.layerInfo = specifiedTimestamp;
      } else if (!specifiedTimestamp && defaultTimestamp) {
        this.info.layerInfo = defaultTimestamp;
        this.options.debug(
          `No correct timestamp ID specified. Picked default ${defaultTimestamp.id}`
        );
      } else if (!specifiedTimestamp && !defaultTimestamp)
        throw new EllipsisVectorLayerBaseError(
          `Specified timestamp with id=${this.options.timestampId} does not exist and the path has no default timestamp to use as a fallback.`
        );
    }

    return;
  };

  recompileStyles = () => {
    this.getFeatures().forEach((x) => this.compileStyle(x));
  };

  compileStyle = (feature) => {
    const st = this.getStyle();
    let compiledStyle = getFeatureStyling(feature, st);
    feature.properties.compiledStyle = compiledStyle;
  };

  getTileId = (tile) => `${tile.zoom}_${tile.tileX}_${tile.tileY}`;

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
