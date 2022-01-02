const parseColor = (color) => {
    const parsed = {
        hex: '000000',
        r: 0, g: 0, b: 0,
        alpha: 0.5
    }
    if (color) {
        const splitHexComponents = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i.exec(color);

        if (!splitHexComponents || (splitHexComponents.length !== 5 && splitHexComponents !== 6))
            return parsed;

        [parsed.r, parsed.g, parsed.b, parsed.alpha] = splitHexComponents.slice(1).map(x => parseInt(x, 16));
        parsed.hex = splitHexComponents.slice(1, 4).join('');
        parsed.alpha = isNaN(parsed.alpha) ? parsed.alpha = 0.5 : parsed.alpha /= 255;
    }

    return parsed;
}

export { parseColor };