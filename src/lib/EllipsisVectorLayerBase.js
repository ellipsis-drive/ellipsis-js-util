import EllipsisApi from "./EllipsisApi";
import { getFeatureStyling, extractStyling, getStyleKeys } from "./VectorLayerUtil";

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
        levelOfDetailMode: 'dynamic',
        levelOfDetailMapper: (zoom) => {
            const transitions = [3, 6, 9, 12, 15]
            const detailLevel = transitions.findIndex(x => zoom < x) + 1;
            return detailLevel === 0 ? 6 : detailLevel
        },
        levelOfDetail: 6
    };

    static optionModifiers = {
        pageSize: (pageSize) => Math.min(3000, pageSize),
        maxMbPerTile: (maxMbPerTile) => maxMbPerTile * 1000000,
        debug: (debug) => debug ? (msg) => console.log(msg) : () => { }
    };


    loadingState = {
        loadInterrupters: [],
        loadingTimeout: undefined,
        cache: {}, // {featureId: [{feature_lod_1}, {feature_lod_2}, ..., {feature_lod_6}], otherFeatureId: [...]}
        featuresInTileCache: {}, // {tileId: [...featureIds], otherTileId: [...featureIds]}
        nextPageStart: undefined,
        isLoading: false,
        updateLock: false,
        missedCall: false
    }

    info = {
        layerInfo: undefined,
        style: undefined
    }

    tiles = [];
    zoom = 1;

    //TODO change the names, and handle undefined style keys
    loadOptions = {
        styleKeys: undefined,
        onEachFeature: undefined
    }

    //Abstract functions
    getMapBounds = () => console.error('get map bounds not implemented');
    updateView = () => console.error('update view not implemented');

    constructor(options = {}) {

        if (!options.pathId)
            options.pathId = options.blockId;
        if (!options.pathId) {
            console.error('no path id specified');
            return;
        }

        if (!options.layerId) {
            console.error('no layer id specified');
            return;
        }

        Object.keys(EllipsisVectorLayerBase.defaultOptions).forEach(x => {
            if (options[x] == undefined)
                options[x] = EllipsisVectorLayerBase.defaultOptions[x];
        });
        Object.keys(EllipsisVectorLayerBase.optionModifiers).forEach(x => options[x] = EllipsisVectorLayerBase.optionModifiers[x](options[x]));
        this.options = {};
        Object.keys(options).forEach(x => this.options[x] = options[x]);

        this.id = `${this.options.pathId}_${this.options.layerId}`;
        this.levelOfDetail = this.options.levelOfDetail;
    }

    getLayerInfo = () => {
        return this.info.layerInfo;
    }

    getFeatures = () => {
        // console.log(this.loadingState.cache)
        // console.log(this.loadingState.featuresInTileCache)
        if (this.options.loadAll) {
            return Object.values(this.loadingState.cache).map(featureCache => featureCache[this.levelOfDetail - 1])
        }
        return this.tiles.flatMap((t) => {
            const featureIdsInTile = this.loadingState.featuresInTileCache[this.getTileId(t)]?.featureIds;
            if (!featureIdsInTile) return []
            return featureIdsInTile.map(idInTile => {
                const cachedFeature = this.loadingState.cache[idInTile];
                return cachedFeature && cachedFeature[this.levelOfDetail - 1]
            }).filter(x => x)
        });
    };

    clearLayer = async () => {
        await this.awaitNotLoading();
        this.loadingState.cache = {};
        this.loadingState.nextPageStart = undefined;
    }

    /**
     * Load everything in current map bounds.
     */
    update = async () => {
        if (this.loadingState.updateLock) return;
        this.options.debug('update..');
        if (!this.info.layerInfo) {
            this.loadingState.updateLock = true;
            await this.fetchLayerInfo();
            this.fetchStylingInfo();
            this.loadingState.updateLock = false;
            this.options.debug('fetched layer info:');
            this.options.debug(this.info.layerInfo);
            this.options.debug('fetched style info:');
            this.options.debug(this.info.style);
        }

        //Don't lock the entire context because we want update to be able to re-calculate tiles
        //while fetching data.
        const viewport = this.getMapBounds();

        if (!viewport) return;

        const maxZoom = this.options.maxZoom === undefined ? this.info.layerInfo.zoom : this.options.maxZoom;

        this.zoom = Math.max(Math.min(maxZoom, viewport.zoom - 2), 0);
        this.tiles = this.boundsToTiles(viewport.bounds, this.zoom);
        this.load(this.updateView, this.options.fetchInterval);
    };

    load = async (onload, timeout) => {
        if (this.loadingState.loadingTimeout)
            return;

        //Keep track of missed call in case an update happened while a load cached nothing.
        if (this.loadingState.isLoading) {
            this.loadingState.missedCall = true;
            return;
        }
        this.loadingState.missedCall = false;

        this.options.debug('load');
        this.loadingState.isLoading = true;
        const cachedSomething = this.options.loadAll ?
            await this.requestAllGeoJsons() :
            await this.requestTileGeoJsons();
        this.loadingState.isLoading = false;
        //Handle load interrupts
        if (this.loadingState.loadInterrupters.length) {
            this.loadingState.loadingTimeout = undefined;
            this.loadingState.loadInterrupters.forEach(x => x());
            this.loadingState.loadInterrupters = [];
            return;
        }

        if (!cachedSomething && !this.loadingState.missedCall) {
            this.options.debug('did not cache new data');
            return;
        }
        this.options.debug('loaded new data, page start: ' + this.loadingState.nextPageStart);
        onload();
        this.loadingState.loadingTimeout = setTimeout(() => {
            this.loadingState.loadingTimeout = undefined;
            this.load(onload, timeout);
        }, timeout);
    };

    awaitNotLoading = (force) => new Promise((res, rej) => {
        if (!this.loadingState.loadingTimeout && !this.loadingState.isLoading)
            return res();

        if (this.loadingState.isLoading)
            return this.loadingState.loadInterrupters.push(() => res());

        if (this.loadingState.loadingTimeout) {
            clearTimeout(this.loadingState.loadingTimeout);
            this.loadingState.loadingTimeout = undefined;
            if (!force)
                return setTimeout(() => res(), this.options.fetchInterval);
            return res();
        }

        rej();
    });

    // TODO look at date
    ensureMaxCacheSize = () => {
        const keys = Object.keys(this.loadingState.featuresInTileCache);
        if (keys.length > this.options.maxTilesInCache) {
            const dates = keys.map((k) => this.loadingState.featuresInTileCache[k].date).sort();
            const clipValue = dates[9];
            keys.forEach((key) => {
                if (this.loadingState.featuresInTileCache[key].date <= clipValue) {
                    // TODO make sure to also delete from this.loadingState.cache
                    delete this.loadingState.featuresInTileCache[key];
                }
            });
        }
    };

    requestAllGeoJsons = async () => {
        if (this.loadingState.nextPageStart === 4)
            return false;

        const body = {
            pageStart: this.loadingState.nextPageStart,
            returnType: this.getReturnType(),
            zipTheResponse: true,
            pageSize: Math.min(3000, this.options.pageSize),
            styleId: this.options.styleId,
            style: this.options.style
        };

        try {
            const res = await EllipsisApi.get(`/path/${this.options.pathId}/vector/layer/${this.options.layerId}/listFeatures`, body, { token: this.options.token });
            this.loadingState.nextPageStart = res.nextPageStart;
            if (!res.nextPageStart)
                this.loadingState.nextPageStart = 4; //EOT (end of transmission)
            if (res.result && res.result.features) {
                res.result.features.forEach(x => {
                    this.compileStyle(x);
                    if (this.loadOptions.onEachFeature)
                        this.loadOptions.onEachFeature(x);
                    this.loadingState.cache[x.properties.id] = x;
                });
            }
        } catch (e) {
            console.error('an error occured with getting all features');
            console.error(e);
            return false;
        }
        return true;
    };

    requestTileGeoJsons = async () => {
        const date = Date.now();
        //create tiles parameter which contains tiles that need to load more features
        const tiles = this.tiles.map((t) => {
            const tileId = this.getTileId(t);

            //If not cached, always try to load features.
            if (!this.loadingState.featuresInTileCache[tileId])
                return { tileId: t }

            const pageStart = this.loadingState.featuresInTileCache[tileId].nextPageStart;


            //Check if tile is not already fully loaded, and if more features may be loaded
            if (pageStart && this.loadingState.featuresInTileCache[tileId].amount <= this.options.maxFeaturesPerTile && this.loadingState.featuresInTileCache[tileId].size <= this.options.maxMbPerTile)
                return { tileId: t, pageStart }

            return null;
        }).filter(x => x);

        if (tiles.length === 0) return false;

        const body = {
            returnType: this.getReturnType(),
            zipTheResponse: true,
            pageSize: this.options.pageSize,
            styleId: this.options.styleId,
            style: this.options.style,
            propertyFilter: (this.options.filter && this.options.filter > 0) ? this.options.filter : null,
        };


        //Get new geometry for the tiles
        let result = [];
        const chunkSize = this.options.chunkSize;
        for (let k = 0; k < tiles.length; k += chunkSize) {
            body.tiles = tiles.slice(k, k + chunkSize);
            try {
                const res = await EllipsisApi.get(`/path/${this.options.pathId}/vector/layer/${this.options.layerId}/featuresByTiles`, body, { token: this.options.token });
                result = result.concat(res);
            } catch (e) {
                console.error('an error occured with getting tile features');
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
            if (result[j].result.features) {
                result[j].result.features.forEach(x => {
                    this.compileStyle(x);
                    if (this.loadOptions.onEachFeature)
                        this.loadOptions.onEachFeature(x);
                });
            }
            tileData.featureIds.push(...result[j].result.features.map(feature => feature.properties.id))

            // Cache feature by id
            result[j].result.features.forEach(feature => {
                const featureId = feature.properties.id;
                if (!this.loadingState.cache[featureId])
                    this.loadingState.cache[featureId] = new Array(6);
                if (!this.loadingState.cache[featureId][this.levelOfDetail - 1])
                    this.loadingState.cache[featureId][this.levelOfDetail - 1] = feature
            })
        }
        return true;
    };

    //Requests layer info for layer with id layerId. Sets this in state.layerInfo.
    fetchLayerInfo = async () => {
        try {
            const info = await EllipsisApi.getPath(this.options.pathId, { token: this.options.token });
            if (!info?.vector?.layers) throw new Error('no layers present in info');
            const layerInfo = info.vector.layers.find(x => x.id === this.options.layerId);

            if (!layerInfo) throw new Error('could not find layer in info');

            this.info.layerInfo = layerInfo;
        } catch (e) {
            console.error('error in fetching layer info: ' + e.message);
        }
    };

    //Reads relevant styling info from state.layerInfo. Sets this in state.styleInfo.
    fetchStylingInfo = () => {
        const keysToExtract = getStyleKeys({ blacklist: ['radius'] });
        if (!this.options.styleId && this.options.style) {
            this.info.style = this.options.style ? extractStyling(this.options.style.parameters, keysToExtract) : undefined;
            return;
        }
        if (!this.info.layerInfo || !this.info.layerInfo.styles) {
            this.info.style = undefined;
            return;
        }

        //Get default or specified style object.
        const rawStyling = this.info.layerInfo.styles.find(s =>
            s.id === this.options.styleId || (s.isDefault && !this.options.styleId));
        this.info.style = rawStyling && rawStyling.parameters ?
            extractStyling(rawStyling.parameters, keysToExtract) : undefined;
    };

    getReturnType = () => {
        if (this.options.centerPoints)
            return "center"
        if (this.info.style.popupProperty)
            return "all"
        return "geometry"
    }

    recompileStyles = () => {
        this.getFeatures().forEach(x => this.compileStyle(x));
    }

    compileStyle = (feature) => {
        let compiledStyle = getFeatureStyling(feature, this.info.style, this.options);
        compiledStyle = extractStyling(compiledStyle, this.loadOptions.styleKeys);
        if (!feature.properties) feature.properties = {};
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
            (zoomComp / comp2) *
            (pi - Math.log(Math.tan(comp3 + (yMax / 360) * pi)))
        );
        const tileYMax = Math.floor(
            (zoomComp / comp2) *
            (pi - Math.log(Math.tan(comp3 + (yMin / 360) * pi)))
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