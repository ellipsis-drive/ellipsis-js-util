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
        fetchInterval: 0
    };

    static optionModifiers = {
        pageSize: (pageSize) => Math.min(3000, pageSize),
        maxMbPerTile: (maxMbPerTile) => maxMbPerTile * 1000000,
        debug: (debug) => debug ? (msg) => console.log(msg) : () => { }
    };


    loadingState = {
        loadInterrupters: [],
        loadingTimeout: undefined,
        cache: [],
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

        if (!options.blockId) {
            console.error('no block id specified');
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

        this.id = `${this.options.blockId}_${this.options.layerId}`;
    }

    getFeatures = () => {
        let features;
        if (this.options.loadAll) {
            features = this.loadingState.cache;
        } else {
            features = this.tiles.flatMap((t) => {
                const geoTile = this.loadingState.cache[this.getTileId(t)];
                return geoTile ? geoTile.elements : [];
            });
        }
        return features;
    };

    clearLayer = async () => {
        await this.awaitNotLoading();
        this.loadingState.cache = [];
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

    ensureMaxCacheSize = () => {
        const keys = Object.keys(this.loadingState.cache);
        if (keys.length > this.options.maxTilesInCache) {
            const dates = keys.map((k) => this.loadingState.cache[k].date).sort();
            const clipValue = dates[9];
            keys.forEach((key) => {
                if (this.loadingState.cache[key].date <= clipValue) {
                    delete this.loadingState.cache[key];
                }
            });
        }
    };

    requestAllGeoJsons = async () => {
        if (this.loadingState.nextPageStart === 4)
            return false;

        const body = {
            pageStart: this.loadingState.nextPageStart,
            mapId: this.options.blockId,
            returnType: this.options.centerPoints ? "center" : "geometry",
            layerId: this.options.layerId,
            zip: true,
            pageSize: Math.min(3000, this.options.pageSize),
            styleId: this.options.styleId,
            style: this.options.style
        };

        try {
            const res = await EllipsisApi.post("/geometry/get", body, { token: this.options.token });
            this.loadingState.nextPageStart = res.nextPageStart;
            if (!res.nextPageStart)
                this.loadingState.nextPageStart = 4; //EOT (end of transmission)
            if (res.result && res.result.features) {
                res.result.features.forEach(x => {
                    this.compileStyle(x);
                    if (this.loadOptions.onEachFeature)
                        this.loadOptions.onEachFeature(x);
                    this.loadingState.cache.push(x);
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
            if (!this.loadingState.cache[tileId])
                return { tileId: t }

            const pageStart = this.loadingState.cache[tileId].nextPageStart;


            //Check if tile is not already fully loaded, and if more features may be loaded
            if (pageStart && this.loadingState.cache[tileId].amount <= this.options.maxFeaturesPerTile && this.loadingState.cache[tileId].size <= this.options.maxMbPerTile)
                return { tileId: t, pageStart }

            return null;
        }).filter(x => x);

        if (tiles.length === 0) return false;

        const body = {
            mapId: this.options.blockId,
            returnType: this.options.centerPoints ? "center" : "geometry",
            layerId: this.options.layerId,
            zip: true,
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
                const res = await EllipsisApi.post("/geometry/tile", body, { token: this.options.token });
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

            if (!this.loadingState.cache[tileId]) {
                this.loadingState.cache[tileId] = {
                    size: 0,
                    amount: 0,
                    elements: [],
                    nextPageStart: null,
                };
            }

            //set tile info for tile in this.
            const tileData = this.loadingState.cache[tileId];
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
            tileData.elements = tileData.elements.concat(result[j].result.features);

        }
        return true;
    };

    //Requests layer info for layer with id layerId. Sets this in state.layerInfo.
    fetchLayerInfo = async () => {
        try {
            const info = await EllipsisApi.getInfo(this.options.blockId, { token: this.options.token });
            if (!info.geometryLayers) throw new Error('no geometrylayers present in info');
            const layerInfo = info.geometryLayers.find(x => x.id === this.options.layerId);

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