import EllipsisApi, { toUrlParams } from "./EllipsisApi";

const getSlippyMapUrl = (options = {}) => {

    const urlAddition = toUrlParams({
        token: options.token,
        layer: options.layer ?? options.visualizationId ?? options.visualization,
        mask: options.mask
    });

    ///path/{pathId}/raster/timestamp/{timestampId}/tile/{z}/{x}/{y}
    let url = `${EllipsisApi.getApiUrl()}/path/${options.pathId ?? options.blockId}/raster/timestamp/${options.timestampId ?? options.captureId}/tile/{z}/{x}/{y}${urlAddition}`;
    return url;
}

const getLayerId = (options = {}) => `${options.pathId ?? options.blockId}_${options.timestampId ?? options.captureId}_${options.visualizationId}_${options.visualization ? encodeURIComponent(JSON.stringify(options.visualization)) : 'novis'}`;

export { getSlippyMapUrl, getLayerId };