import { EllipsisApi } from "./EllipsisApi";

const getSlippyMapUrl = (options) => {

    if (options.visualization) {
        let url = `${EllipsisApi.getApiUrl()}/settings/mapLayers/preview/${options.blockId}/${options.captureId}/${options.visualization.method}/{z}/{x}/{y}?parameters=${JSON.stringify(options.visualization.parameters)}`;
        if (options.token) url += '&token=' + options.token;
        return url;
    }
    let url = `${EllipsisApi.getApiUrl()}/tileService/${options.blockId}/${options.captureId}/${options.visualizationId}/{z}/{x}/{y}`;
    if (options.token) url += '?token=' + options.token;

    return url;
}
export { getSlippyMapUrl };