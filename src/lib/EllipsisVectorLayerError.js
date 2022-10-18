


export default class EllipsisVectorLayerBaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "EllipsisVectorLayerError";
  }
}