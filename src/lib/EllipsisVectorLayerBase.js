import EllipsisApi from "./EllipsisApi";

class EllipsisVectorLayerBase {

    destroy = () => {
        if (this.gettingVectorsInterval)
            clearInterval(this.gettingVectorsInterval);
    }

    constructor(options = {}) {

        if (!options.blockId) {
            console.error('no block id specified');
            return;
        }

        if (!options.layerId) {
            console.error('no layer id specified');
            return;
        }

        if (!options.getMapBounds) {
            console.error('no getMapBounds method specified');
            return;
        }

        if (!options.updateView) {
            console.error('no view updater specified');
            return;
        }

        Object.keys(EllipsisVectorLayerBase.defaultOptions).forEach(x => {
            if (options[x] == undefined)
                options[x] = EllipsisVectorLayerBase.defaultOptions[x];
        });
        Object.keys(EllipsisVectorLayerBase.optionModifiers).forEach(x => options[x] = EllipsisVectorLayerBase.optionModifiers[x](options[x]));
        Object.keys(options).forEach(x => this[x] = options[x]);

        this.id = `${blockId}_${layerId}`;
        this.blockId = blockId;
        this.layerId = layerId;
        this.tiles = [];
        this.cache = [];
        this.zoom = 1;
    }

    getFeatures = () => {
        let features;
        if (this.loadAll) {
            features = this.cache;
        } else {
            features = this.tiles.flatMap((t) => {
                const geoTile = this.cache[this.getTileId(t)];
                return geoTile ? geoTile.elements : [];
            });
        }
        return features;
    }

    update = async () => {
        const viewport = await this.getMapBounds();
        if (!viewport) return;
        this.zoom = Math.max(Math.min(this.maxZoom, viewport.zoom - 2), 0);
        this.tiles = this.boundsToTiles(viewport.bounds, this.zoom);
        if (this.gettingVectorsInterval) return;
        this.gettingVectorsInterval = setInterval(async () => {
            if (this.isLoading) return;
            const loadedSomething = await this.loadStep();
            this.debug(`performed load step, loadedsomething: ${loadedSomething}`);

            if (this.afterLoadHandler && this.afterLoadHandler()) {
                this.debug('after load handler has overwritten load');
                return;
            }

            if (!loadedSomething) {
                clearInterval(this.gettingVectorsInterval);
                this.gettingVectorsInterval = undefined;
                return;
            }
            this.updateView();
        }, 100);
    };

    loadStep = async () => {
        this.isLoading = true;
        if (this.loadAll) {
            const cachedSomething = await this.getAndCacheAllGeoJsons();
            this.isLoading = false;
            return cachedSomething;
        }

        this.ensureMaxCacheSize();
        const cachedSomething = await this.getAndCacheTileGeoJsons();
        this.isLoading = false;
        return cachedSomething;
    };

    ensureMaxCacheSize = () => {
        const keys = Object.keys(this.cache);
        if (keys.length > this.maxTilesInCache) {
            const dates = keys.map((k) => this.cache[k].date).sort();
            const clipValue = dates[9];
            keys.forEach((key) => {
                if (this.cache[key].date <= clipValue) {
                    delete this.cache[key];
                }
            });
        }
    };

    getAndCacheAllGeoJsons = async () => {
        if (this.nextPageStart === 4)
            return false;

        const body = {
            pageStart: this.nextPageStart,
            mapId: this.blockId,
            returnType: this.centerPoints ? "center" : "geometry",
            layerId: this.layerId,
            zip: true,
            pageSize: Math.min(3000, this.pageSize),
            styleId: this.styleId,
            style: this.style
        };

        try {
            const res = await EllipsisApi.post("/geometry/get", body, { token: this.token });
            this.nextPageStart = res.nextPageStart;
            if (!res.nextPageStart)
                this.nextPageStart = 4; //EOT (end of transmission)
            if (res.result && res.result.features) {
                res.result.features.forEach(x => {
                    if (this.featureFormatter)
                        this.featureFormatter(x);
                    this.cache.push(x);
                });
            }
        } catch (e) {
            console.error('an error occured with getting all features');
            console.error(e);
            return false;
        }
        return true;
    }

    getAndCacheTileGeoJsons = async () => {
        const date = Date.now();
        //create tiles parameter which contains tiles that need to load more features
        const tiles = this.tiles.map((t) => {
            const tileId = this.getTileId(t);

            //If not cached, always try to load features.
            if (!this.cache[tileId])
                return { tileId: t }

            const pageStart = this.cache[tileId].nextPageStart;


            //Check if tile is not already fully loaded, and if more features may be loaded
            if (pageStart && this.cache[tileId].amount <= this.maxFeaturesPerTile && this.cache[tileId].size <= this.maxMbPerTile)
                return { tileId: t, pageStart }

            return null;
        }).filter(x => x);

        if (tiles.length === 0) return false;

        const body = {
            mapId: this.blockId,
            returnType: this.centerPoints ? "center" : "geometry",
            layerId: this.layerId,
            zip: true,
            pageSize: this.pageSize,
            styleId: this.styleId,
            style: this.style,
            propertyFilter: (this.filter && this.filter > 0) ? this.filter : null,
        };


        //Get new geometry for the tiles
        let result = [];
        const chunkSize = 10;
        for (let k = 0; k < tiles.length; k += chunkSize) {
            body.tiles = tiles.slice(k, k + chunkSize);
            try {
                const res = await EllipsisApi.post("/geometry/tile", body, { token: this.token });
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

            if (!this.cache[tileId]) {
                this.cache[tileId] = {
                    size: 0,
                    amount: 0,
                    elements: [],
                    nextPageStart: null,
                };
            }

            //set tile info for tile in this.
            const tileData = this.cache[tileId];
            tileData.date = date;
            tileData.size = tileData.size + result[j].size;
            tileData.amount = tileData.amount + result[j].result.features.length;
            tileData.nextPageStart = result[j].nextPageStart;
            if (this.featureFormatter) {
                result[j].result.elements.forEach(x => this.featureFormatter(x));
            }
            tileData.elements = tileData.elements.concat(result[j].result.features);

        }
        return true;
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

//React-style defaults to allow easy porting.
EllipsisVectorLayerBase.defaultOptions = {
    centerPoints: false,
    maxZoom: 21,
    pageSize: 25,
    maxMbPerTile: 16,
    maxTilesInCache: 500,
    maxFeaturesPerTile: 500,
    radius: 6,
    lineWidth: 2, //TODO also change in readme
    useMarkers: false,
    loadAll: false,
    refreshTilesStep: 1
};

EllipsisVectorLayerBase.optionModifiers = {
    pageSize: (pageSize) => Math.min(3000, pageSize),
    maxMbPerTile: (maxMbPerTile) => maxMbPerTile * 1000000,
    debug: (debug) => debug ? (msg) => console.log(msg) : () => { }
};

export default EllipsisVectorLayerBase;