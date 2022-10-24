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
    style:
      options.style ??
      options.layer ??
      options.visualizationId ??
      options.visualization,
    mask: options.mask,
  };

  let timestampId = options.timestampId ?? options.captureId;
  const pathId = options.pathId ?? options.blockId;

  if (!timestampId || !params.style) {
    const metadata = await EllipsisApi.getPath(pathId);
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

    if (!params.style) {
      const defaultStyle = metadata.raster.styles?.find(
        (style) => style.default
      );
      if (!defaultStyle)
        throw new EllipsisRasterLayerError("No default style found");
      params.style = defaultStyle.id;
    }
  }

  let url = `${EllipsisApi.getApiUrl()}/path/${pathId}/raster/timestamp/${timestampId}/tile/{z}/{x}/{y}${toUrlParams(
    params
  )}`;
  return url;
};

const getLayerId = (options = {}) =>
  `${options.pathId ?? options.blockId}_${
    options.timestampId ?? options.captureId
  }_${encodeURIComponent(
    JSON.stringify(
      options.style ?? options.visualizationId ?? options.visualization
    )
  )}`;

export { getSlippyMapUrl, getLayerId, getSlippyMapUrlWithDefaults };
