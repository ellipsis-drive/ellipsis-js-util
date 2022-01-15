import EllipsisVectorLayerBase from "./EllipsisVectorLayerBase";
import { mergeObjects } from "./Util";

const defaultStyle = {
    radius: 6,
    width: 2,
    borderColor: '#000000',
    borderOpacity: 1,
    fillColor: '#000000',
    fillOpacity: 0.5
}

//Map style keys to possible aliases
const styleKeys = {
    radius: [],
    width: ['lineWidth', 'weight'],
    borderColor: [],
    borderOpacity: [],
    fillColor: ['color'],
    fillOpacity: ['opacity']
}

const getStyleKeys = (filters = { blacklist: [] }) => {
    return Object.fromEntries(Object.entries(styleKeys).filter(([key]) => {
        if (filters.blacklist.includes(key))
            return false;
        if (filters.whitelist && !filters.whitelist.includes(key))
            return false;
        return true;
    }));
}

const parseHex = (color, toRGB) => {
    if (!color) return;

    const splitHexComponents = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i.exec(color);

    //Retreive all color components from hex
    let [r, g, b, alpha] = splitHexComponents.slice(1).map(x => parseInt(x, 16));
    alpha = isNaN(alpha) ? alpha = undefined : alpha /= 255;


    if (toRGB) return { r, g, b, opacity: 1 - alpha };
    return { color: `#${splitHexComponents.slice(1, 4).join('')}`, opacity: 1 - alpha };
}

//Finds styling info based on styleKeysInfo. It'll return all style info with the style
//keys described in styleKeysInfo.
const extractStyling = (obj = {}, styleKeysInfo = styleKeys) => {
    const styling = {};
    Object.entries(obj).forEach(([key, value]) => {
        const standardStylingEntries = Object.entries(styleKeysInfo).filter(([styleKey, styleAliases]) => {
            return styleKey === key || (styleAliases && styleAliases.includes(key));
        });
        if (standardStylingEntries && standardStylingEntries.length) {
            standardStylingEntries.forEach(([k]) => styling[k] = value)
        }
    });
    return styling;
}

/**
 * Parses hex color values from feature to create an object that has all styling
 * parameters merged, which does include default stylings.
 * Priority of the different places to pass styling:
 * 1) ...stylingSources
 * 2) feature.properties
 * 3) default styling
 * @param {*} feature 
 * @param {*} stylingOptions 
 * @returns {*}
 */
const getFeatureStyling = (feature, ...stylingSources) => {

    //Extract style info from feature.properties, getinfo.style and stylingOptions.
    const propertyStyle = feature && feature.properties ? extractStyling(feature.properties) : undefined;

    //Rightmost value will take precidence over values to the left in merge.
    let combinedStyles = mergeObjects(propertyStyle, ...stylingSources.map(x => x ? extractStyling(x) : undefined));


    //Split hex values in opacity and hex value if possible.
    let parsedBorderColor = parseHex(combinedStyles.borderColor);
    let parsedFillColor = parseHex(combinedStyles.fillColor);


    //If no fill color present, take color from border.
    if (parsedBorderColor && !parsedFillColor) {
        parsedFillColor = { ...parsedBorderColor };
        parsedBorderColor.opacity = 1;
    }

    //If no border color present, take color from fill.
    if (!parsedBorderColor && parsedFillColor) {
        parsedBorderColor = { ...parsedFillColor };
        parsedBorderColor.opacity = 1;
    }

    //If we parsed colors, combine the results 
    if (parsedBorderColor) {
        //Merge priority: 
        //1) parsed colors, 
        //2) opacities found in style, 
        //3) parsed opacities
        combinedStyles = mergeObjects({
            fillOpacity: parsedFillColor.opacity,
            borderOpacity: parsedBorderColor.opacity
        }, combinedStyles, {
            fillColor: parsedFillColor.color,
            borderColor: parsedBorderColor.color,
        });
    }

    //Ensure the default values for all values that are not set in combined styles.
    return mergeObjects(defaultStyle, combinedStyles);
}

export {
    EllipsisVectorLayerBase,
    defaultStyle,
    getFeatureStyling, parseHex, extractStyling, getStyleKeys
};