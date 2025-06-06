import EllipsisApi, { toUrlParams } from "./EllipsisApi";
import EllipsisRasterLayerError from "./EllipsisRasterLayerError";

const getSlippyMapUrl = (options = {}) => {
  const urlAddition = toUrlParams({
    token: options.token,
    style:
      options.style ??
      options.layer ??
      options.visualizationId ??
      options.visualization,
    mask: options.mask,
    epsg: options.epsg,
  });

  let url = `${EllipsisApi.getApiUrl()}/path/${
    options.pathId ?? options.blockId
  }/raster/timestamp/${
    options.timestampId ?? options.captureId
  }/tile/{z}/{x}/{y}${urlAddition}`;
  return url;
};

const getSlippyMapUrlWithDefaults = async (options = {}) => {
  const params = {
    token: options.token,
    style: options.style,
    mask: options.mask,
  };

  let timestampId = options.timestampId;
  const pathId = options.pathId;
  let zoom = options.zoom;

  if (!timestampId || !params.style || !zoom) {
    const metadata = await EllipsisApi.getPath(pathId, { token: params.token });
    if (!metadata)
      throw new EllipsisRasterLayerError(
        `Could not fetch data of path with id ${pathId}`
      );
    if (metadata.type !== "raster")
      throw new EllipsisRasterLayerError(`Path is not of type raster`);

    if (!timestampId) {
      if (!metadata.raster?.timestamps?.length)
        throw new EllipsisRasterLayerError(
          `There are no timestamps in this path`
        );
      const defaultTimestamp = metadata.raster.timestamps
        .reverse()
        .find(
          (timestamp) =>
            !timestamp.availability.blocked &&
            !timestamp.trashed &&
            timestamp.status === "active"
        );

      if (!defaultTimestamp)
        throw new EllipsisRasterLayerError(
          "Could not find a valid default timestamp."
        );

      timestampId = defaultTimestamp.id;
    }
    if (!zoom) {
      let stamp = metadata.raster.timestamps.find((t) => t.id === timestampId);
      if (!stamp)
        throw new EllipsisRasterLayerError("Given timestampId does not exist");
      zoom = stamp.zoom;
    }

    if (!params.style) {
      const defaultStyle = metadata.raster.styles?.find(
        (style) => style.default
      );
      if (!defaultStyle)
        throw new EllipsisRasterLayerError("No default style found");
      params.style = defaultStyle.id;
    }
  }

  if (options.epsg) {
    params.epsg = options.epsg;
  }

  let url = `${EllipsisApi.getApiUrl()}/path/${pathId}/raster/timestamp/${timestampId}/tile/{z}/{x}/{y}${toUrlParams(
    params
  )}`;

  return { zoom, url, id: url + "_" + zoom };
};

const getLayerId = (options = {}) =>
  `${options.pathId ?? options.blockId}_${
    options.timestampId ?? options.captureId
  }_${encodeURIComponent(JSON.stringify(options.style))}`;

export { getSlippyMapUrl, getLayerId, getSlippyMapUrlWithDefaults };
