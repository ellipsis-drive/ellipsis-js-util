const mergeObjects = (...objects) => {

    let a = objects[objects.length - 2], b = objects[objects.length - 1];
    if (a === undefined) a = {};
    if (b === undefined) b = {};

    const merged = Object.fromEntries(Object.keys({ ...a, ...b })
        .map(key => [key, (b[key] === undefined ? a[key] : b[key])]));
    if (objects.length > 2)
        return mergeObjects(...[...objects.slice(0, objects.length - 2), merged]);
    return merged;
}

export { mergeObjects };