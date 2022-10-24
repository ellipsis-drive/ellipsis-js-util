export default class EllipsisRasterLayerError extends Error {
  constructor(message) {
    super(message);
    this.name = "EllipsisRasterLayerError";
  }
}
